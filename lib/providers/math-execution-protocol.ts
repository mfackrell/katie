export const MATH_EXECUTION_PROTOCOL = `CALCULATION_RESPONSE_PROTOCOL:
1. Give the user the calculation result and the reasoning needed to understand it in a clean, concise format.
2. Do NOT expose scratch work, generated scripts, Python/JavaScript code, or internal calculation scaffolding unless the user explicitly asks to see the calculation code or implementation.
3. Multi-step logic does NOT require code by itself. Use code only when it is genuinely useful and the runtime actually provides an execution tool.
4. Never label generated code or model-written calculations as a "Verification Source."
5. Never claim that code was executed, verified, run, or independently checked unless the runtime actually executed a tool and returned a result.
6. If executable tooling was actually used and the user asks for the details, label that section "Calculation details" and distinguish tool output from model explanation.
END_CALCULATION_RESPONSE_PROTOCOL`;
