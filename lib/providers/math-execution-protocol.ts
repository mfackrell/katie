export const MATH_EXECUTION_PROTOCOL = `MATH_EXECUTION_PROTOCOL:
1. MANDATORY CODE USE: For any request involving arithmetic, compound interest, growth rates, or multi-step logic, you MUST write and execute a script (Python or JavaScript).
2. NEGATIVE CONSTRAINT: You are STRICTLY FORBIDDEN from performing calculations in plain text or using LaTeX for scratchpad work. If you provide a numerical answer without a supporting code block, the response is a FAILURE.
3. OUTPUT ORDER: State the final result first, followed immediately by the code block that generated it as the "Verification Source."
END_MATH_EXECUTION_PROTOCOL`;
