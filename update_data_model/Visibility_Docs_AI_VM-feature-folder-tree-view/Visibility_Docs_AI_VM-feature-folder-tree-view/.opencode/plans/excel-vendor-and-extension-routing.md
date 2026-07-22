# Plan: Fix Excel Vendor Data + Extension-Based Routing

## Issue
1. Excel file (50 rows table data) → vendor query returns "vendor nhi hay"
2. Root cause: finance query path skips raw chunk_text (which has table rows) and only uses structured extraction (which is empty for Excel)

## Step 1: Quick Fix — Include chunk_text in finance path

**File:** `backend/app/services/chat_service.py`

**Location:** Lines 720-746

**Current behavior:**
- `is_finance_query=True` → `_fetch_extraction_summary()` → returns empty for Excel
- Falls through to normal path → works IF search_results exist
- But if no search_results (org-wide, no matching keyword), LLM gets no data

**Fix:**
- Change the finance path condition from `if finance_context:` to `if is_finance_query and (finance_context or search_results):`
- When taking finance path, always append `search_results` chunk_text alongside extraction data
- This ensures Excel table rows are always available to LLM

**Exact code change:**
Replace the entire `if finance_context:` block (lines 725-746) with a version that:
1. Fetches extraction summary (may be empty for Excel)
2. Also collects chunk_text from search_results
3. Merges both → sends to LLM
4. Returns answer with sources (not empty sources)

## Step 2: Extension-Based Agent Routing (Future)

**File:** `backend/app/services/chat_service.py` + maybe new agent

**Concept:**
Upload ya chat query ke time file extension detect karo aur specialized agent assign karo:

| Extension | Detected Type | Routing |
|-----------|--------------|---------|
| `.xlsx`, `.csv` | Spreadsheet | Use raw table rows as context, aggregation queries |
| `.pdf` | Document | Current OCR + heading + chunking pipeline |
| `.docx` | Word | Text extraction, paragraph-level queries |
| `.jpg`, `.png` | Image | Image analysis agent |
| `.txt`, `.json`, `.xml` | Other | Generic text extraction |

**Implementation approach:**

### A) Upload-time detection (in `orchestrator_service.py`)
- After file upload, detect extension from `original_file_url` or filename
- For `.xlsx`/`.csv`: store `phase3_agent = "excel_agent"` or a new `_table_type_` flag on the document
- Table data already gets extracted by `_extract_xlsx()` → stored in raw_text
- No change needed in indexing; just tag the document

### B) Chat-time routing (in `chat_service.py`)
- Before deciding search strategy, check if selected documents are Excel/sheet type
- If yes, adjust:
  - Don't use `aggregate_search` (no need for cross-doc)
  - Use `hybrid_search` with higher limit (to get all rows)
  - Build context from all available chunks (don't truncate early)
  - Use a table-aware system prompt

### C) Table-aware system prompt
- For Excel/sheet queries, use a prompt like:
  ```
  You have access to table data from [filename].
  The data is in markdown table format with columns: [columns]
  Answer the user's question based on this data.
  ```
- This is more effective than the generic finance agent prompt

## Comparison

| Aspect | Step 1 (Quick Fix) | Step 2 (Extension Routing) |
|--------|-------------------|---------------------------|
| Complexity | ~20 lines change | ~50 lines + new logic |
| Risk | Low | Medium |
| Time | 5 min | 30 min |
| Excel fix | ✅ Yes | ✅ Yes |
| All file types | ❌ No | ✅ Yes |
| Maintainability | Same | Better |

## Recommendation

**Immediate:** Do Step 1 (5 min fix) — Excel vendor data ka issue resolve ho jayega

**Then:** Defer Step 2 for when a clearer need arises for other file types. Extension routing acha concept hai lekin abhi sirf Excel ka issue hay jo Step 1 se solve ho jayega. Step 2 mehnat zyada hay aur immediate benefit wahi hay jo Step 1 de raha.
