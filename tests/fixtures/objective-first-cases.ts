export const objectiveFirstCases = [
  { name: "BTG application", task: "Please describe your experience leading finance for a global industrial/manufacturing business, including any audit remediation and international transfer pricing work. Include company revenue sizes.",
    facts: "25 years finance/accounting and cross-functional executive leadership. Manufacturing experience in multiple engagements, including international sales and marketing responsibilities. Multinational experience in separate engagements, not as CFO of a global manufacturer. Interim leadership in a PE-owned global professional services firm: annual revenue $90M, enterprise valuation $200M; 18 months of unclosed books after a poor NetSuite implementation and prior staff loss; new team; audit completed in ten weeks; due diligence support. Multiple ERP implementations. No direct international transfer-pricing experience. No verified manufacturing-company revenue figures have been supplied.",
    stance: "APPLICATION RESPONSE", outcome: "A truthful, persuasive application answer" },
  { name: "fit assessment", task: "Assess my fit for this global manufacturing Interim CFO opportunity. Evaluate qualifications and material gaps; do not draft an application yet.",
    facts: "Manufacturing and multinational leadership in separate companies; no international transfer pricing experience.",
    stance: "FIT ASSESSMENT", outcome: "A balanced evaluation of qualifications and material gaps" },
  { name: "financial analysis", task: "Analyze the next-month cash position. Opening cash 100000; receipts 40000; payments 160000. Identify the shortfall. Use only these figures; do not assume financing.",
    facts: "No financing source or payment deferral has been confirmed.", stance: "FINANCIAL REPORT", outcome: "Neutral financial analysis with a 20000 cash shortfall and explicit uncertainty" },
  { name: "technical diagnosis", task: "Diagnose why the video upload failed. Logs show the upload saved, Gemini returned 429, and the RunPod job was never submitted. Change nothing.",
    facts: "No evidence confirms a successful fallback or deployment.", stance: "TECHNICAL WORK", outcome: "Evidence-based diagnosis without an unsupported fix or deployment claim" },
  { name: "business communication", task: "Draft a concise message to a vendor about an overdue invoice. Explain that payment timing is still being confirmed and promise an update Friday, not payment Friday. Preserve the relationship without inventing assurances.",
    facts: "Invoice is overdue. Funding and payment timing are not confirmed. An update can be provided Friday. No payment date is authorized.", stance: "PROPOSAL", outcome: "Clear, respectful communication without an invented payment commitment" },
];
