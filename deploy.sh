#!/usr/bin/env bash
# ==============================================================================
# Visibility Docs AI — Linux Server Deploy & Model Pre-packaging Script
# ==============================================================================

set -e

echo "================================================================="
echo "  🚀 Starting Linux Server Production Deployment & Model Setup"
echo "================================================================="

# Detect Python 3
PYTHON_CMD="python"
if command -v python3 &> /dev/null; then
    PYTHON_CMD="python3"
fi

echo "📌 Using Python executable: $($PYTHON_CMD --version)"

# 1. Install dependencies
if [ -f "ai-backend/requirements.txt" ]; then
    echo "📦 [1/3] Installing Backend Dependencies..."
    $PYTHON_CMD -m pip install -r ai-backend/requirements.txt
fi

# 2. Download and Pre-package Models directly inside deploy script
echo "🧠 [2/3] Downloading & Pre-packaging Production AI Models (BAAI 1024-Dim & ms-marco)..."
$PYTHON_CMD -c "
import os
import sys
from sentence_transformers import SentenceTransformer, CrossEncoder

base_dir = os.path.abspath('ai-backend/data/local_models')

# 1. BAAI Vector Model
model_1 = 'BAAI/bge-large-en-v1.5'
path_1 = os.path.join(base_dir, model_1.replace('/', '_').replace('-', '_'))
if not os.path.exists(path_1):
    print(f'📥 [A] Downloading 1024-dim Vector Model: {model_1}...')
    bge = SentenceTransformer(model_1, device='cpu')
    os.makedirs(path_1, exist_ok=True)
    bge.save(path_1)
print('✅ BAAI/bge-large-en-v1.5 (1024-Dim) Pre-packaged Successfully!')

# 2. Cross-Encoder Model
model_2 = 'cross-encoder/ms-marco-MiniLM-L-6-v2'
path_2 = os.path.join(base_dir, model_2.replace('/', '_').replace('-', '_'))
if not os.path.exists(path_2):
    print(f'📥 [B] Downloading Reranker Model: {model_2} (88MB)...')
    ce = CrossEncoder(model_2, device='cpu')
    os.makedirs(path_2, exist_ok=True)
    ce.save(path_2)
print('✅ ms-marco-MiniLM-L-6-v2 (88MB) Pre-packaged Successfully!')

print('🎉 Both AI Models are Pre-packaged and Ready on Linux Server!')
"

# 3. Start Backend Server
echo "🌐 [3/3] Launching Production Backend Server on Port 8001..."
cd ai-backend
exec uvicorn app.main:app --host 0.0.0.0 --port 8001 --workers 2
