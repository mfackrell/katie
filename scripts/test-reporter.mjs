import { writeFileSync } from "node:fs";
import { inspect } from "node:util";

// Runs in each test process. A report is written only after the runner's final
// summary, so an early process.exit(0) cannot masquerade as a completed suite.
export default async function* report(events) {
  let completed = 0;
  let summary;
  for await (const event of events) {
    const { type, data } = event;
    if (type === "test:pass" || type === "test:fail") {
      if (data.details?.type === "test") completed += 1;
      if (type === "test:fail") yield `FAIL ${data.name}\n${inspect(data.details.error, { depth: 5 })}\n`;
    }
    if (type === "test:stdout" || type === "test:stderr") yield data.message;
    if (type === "test:summary") summary = data;
  }
  if (summary) {
    writeFileSync(process.env.KATIE_TEST_REPORT_PATH, JSON.stringify({ ...summary, completed }));
    yield `${JSON.stringify(summary.counts)}\n`;
  }
}
