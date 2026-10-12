import chromium from "@sparticuz/chromium";

// Node's test runner uses separate processes. Finish the shared /tmp extraction
// before two real-browser test files can launch concurrently on a cold CI runner.
await chromium.executablePath();
