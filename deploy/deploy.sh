#!/bin/bash
# Auto-deploy for visibility-docs-ai.
#
# Invoked ONLY via the restricted GitHub Actions SSH key installed in
# /root/.ssh/authorized_keys on the VPS (forced-command, can't run anything else).
#
# Safety model: every changed service is built and validated in an isolated
# scratch worktree first. The live directory under /var/www is only ever
# touched by a fast rsync AFTER a build has already proven itself. A failed
# build never touches what's currently running, and pm2 is only restarted
# on success.
#
# NOTE: this file is version-controlled here for visibility, but the copy
# that actually runs lives at a fixed path on the VPS
# (/var/www/docs.visibilitybots.com-deploy/deploy.sh) since it has to exist
# before the very first `git fetch`. Keep that copy in sync manually when
# this file changes.
set -euo pipefail

REPO_DIR=/var/www/docs.visibilitybots.com
DEPLOY_DIR=/var/www/docs.visibilitybots.com-deploy
SCRATCH="$DEPLOY_DIR/scratch"
STATE_FILE="$DEPLOY_DIR/.last_deployed_sha"
LOCK_FILE="$DEPLOY_DIR/deploy.lock"
LOG_FILE="$DEPLOY_DIR/deploy.log"

exec 200>"$LOCK_FILE"
flock -n 200 || { echo "$(date -u +%FT%TZ) deploy already running, skipping"; exit 1; }

exec >>"$LOG_FILE" 2>&1
echo "=== $(date -u +%FT%TZ) deploy start ==="

cd "$REPO_DIR"
git fetch origin main
NEW_SHA=$(git rev-parse origin/main)
OLD_SHA=$(cat "$STATE_FILE" 2>/dev/null || git rev-parse HEAD)

if [ "$OLD_SHA" = "$NEW_SHA" ]; then
  echo "Already at $NEW_SHA, nothing to do."
  exit 0
fi
echo "Deploying $OLD_SHA -> $NEW_SHA"

CHANGED=$(git diff --name-only "$OLD_SHA" "$NEW_SHA" 2>/dev/null || echo "__unknown__")
want() { [ "$CHANGED" = "__unknown__" ] || echo "$CHANGED" | grep -q "^$1/"; }

mkdir -p "$SCRATCH"
WT="$SCRATCH/worktree"
if git -C "$REPO_DIR" worktree list | grep -q "$WT"; then
  git -C "$WT" checkout -f --detach "$NEW_SHA"
else
  git worktree add -f --detach "$WT" "$NEW_SHA"
fi

FAILED=0

if want frontend; then
  echo "--- frontend ---"
  # NOTE on the `( ... ) && RESULT=0 || RESULT=$?` shape below: two bash
  # gotchas stacked here. (1) `if ( set -e; ... ); then` silently ignores the
  # inner `set -e` because the subshell is the condition of an if. (2) Making
  # it a bare statement instead means ITS failure trips the outer script's
  # own `set -euo pipefail`, aborting before `RESULT=$?` is ever reached.
  # Putting the subshell in a `&&`/`||` list sidesteps both: bash's errexit
  # explicitly does not fire for a command that's part of an AND-OR list.
  ( set -e
    cp "$REPO_DIR/frontend/.env" "$WT/frontend/.env"
    cd "$WT/frontend"
    npm install
    npm run build
  ) && RESULT=0 || RESULT=$?
  if [ "$RESULT" -eq 0 ]; then
    rsync -a --delete --exclude '.env' "$WT/frontend/" "$REPO_DIR/frontend/"
    pm2 restart docs-frontend
    echo "frontend: promoted"
  else
    echo "frontend: BUILD FAILED -- previous version left running untouched"
    FAILED=1
  fi
fi

if want api-gateway; then
  echo "--- api-gateway ---"
  ( set -e
    cp "$REPO_DIR/api-gateway/.env" "$WT/api-gateway/.env"
    cd "$WT/api-gateway"
    npm install
    npm run build
  ) && RESULT=0 || RESULT=$?
  if [ "$RESULT" -eq 0 ]; then
    rsync -a --delete --exclude '.env' "$WT/api-gateway/" "$REPO_DIR/api-gateway/"
    pm2 restart docs-api
    echo "api-gateway: promoted"
  else
    echo "api-gateway: BUILD FAILED -- previous version left running untouched"
    FAILED=1
  fi
fi

if want ai-backend; then
  echo "--- ai-backend ---"
  # Blue/green venvs: install/validate into the currently-INACTIVE slot so a
  # broken requirements.txt or import error never touches the live venv.
  LIVE_VENV_LINK="$REPO_DIR/ai-backend/venv"
  CURRENT_TARGET=$(readlink -f "$LIVE_VENV_LINK" 2>/dev/null || echo "")
  if [ "$CURRENT_TARGET" = "$(readlink -f "$SCRATCH/ai-backend-venv-a" 2>/dev/null || echo __a__)" ]; then
    NEXT_VENV="$SCRATCH/ai-backend-venv-b"
  else
    NEXT_VENV="$SCRATCH/ai-backend-venv-a"
  fi

  ( set -e
    cp "$REPO_DIR/ai-backend/.env" "$WT/ai-backend/.env"
    [ -d "$NEXT_VENV" ] || python3 -m venv "$NEXT_VENV"
    "$NEXT_VENV/bin/pip" install --upgrade pip -q
    "$NEXT_VENV/bin/pip" install -r "$WT/ai-backend/requirements.txt" -q
    cd "$WT/ai-backend"
    # Real boot check (not just a successful pip install): catches import-time
    # and startup-config errors that `pip install` alone would miss. Poll
    # instead of a fixed sleep since a cold venv's first import of torch/
    # transformers can legitimately take longer than a fixed few seconds.
    "$NEXT_VENV/bin/python" -m uvicorn app.main:app --host 127.0.0.1 --port 8999 &
    UVPID=$!
    READY=0
    for i in $(seq 1 30); do
      if ! kill -0 $UVPID 2>/dev/null; then
        echo "ai-backend: process exited during boot check"
        break
      fi
      if curl -fsS http://127.0.0.1:8999/docs -o /dev/null 2>/dev/null; then
        READY=1
        break
      fi
      sleep 1
    done
    kill $UVPID 2>/dev/null || true
    wait $UVPID 2>/dev/null || true
    [ "$READY" -eq 1 ]
  ) && RESULT=0 || RESULT=$?
  if [ "$RESULT" -eq 0 ]; then
    rsync -a --delete \
      --exclude '.env' --exclude 'venv' --exclude 'uploads' \
      --exclude 'processed' --exclude 'docs_ai.db' \
      "$WT/ai-backend/" "$REPO_DIR/ai-backend/"
    ln -sfn "$NEXT_VENV" "$LIVE_VENV_LINK"
    pm2 restart docs-ai-backend
    echo "ai-backend: promoted (venv -> $NEXT_VENV)"
  else
    echo "ai-backend: BUILD FAILED -- previous version left running untouched"
    FAILED=1
  fi
fi

if [ "$FAILED" -eq 0 ]; then
  echo "$NEW_SHA" > "$STATE_FILE"
  pm2 save
  echo "=== $(date -u +%FT%TZ) deploy finished: promoted to $NEW_SHA ==="
else
  echo "=== $(date -u +%FT%TZ) deploy finished WITH FAILURES; state not advanced, next run retries $OLD_SHA -> $NEW_SHA ==="
  exit 1
fi
