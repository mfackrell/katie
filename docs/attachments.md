# Attachments

Katie supports plain text and common business document uploads. Files are validated by MIME type first and file extension second.

## Supported text extraction formats
- `.txt` (`text/plain`)
- `.md` (`text/markdown`)
- `.json` (`application/json`)
- `.csv` (`text/csv`)
- `.docx` (`application/vnd.openxmlformats-officedocument.wordprocessingml.document`)
- `.doc` (`application/msword`, best-effort via Word parser fallback)
- `.xlsx` (`application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`)
- `.xls` (`application/vnd.ms-excel`)
- `.pdf` (`application/pdf`)

## Limits
- Maximum of **5 files per upload**.
- Text-friendly formats (`.txt`, `.md`, `.json`, `.csv`) are limited to **2 MB** each.
- Binary office and PDF formats (`.docx`, `.doc`, `.xlsx`, `.xls`, `.pdf`) are limited to **8 MB** each.
- Extracted text is truncated to **50,000 characters** with a visible `[truncated]` suffix.

## Extraction caveats
- Formatting is not preserved for Word, Excel, or PDF extraction.
- Legacy `.doc` parsing is best-effort and may fail; users should convert to `.docx` for reliability.
- Excel extraction flattens sheets to TSV text and only includes the first **20 sheets**.
- PDF extraction may scramble table/column order depending on source encoding.
- Control characters and null bytes are stripped from extracted content.
