/**
 * Pure helpers used by `chatParticipant.ts` to assemble prompts.
 * Kept in their own module so they are unit-testable outside a VS Code
 * host (mocha cannot load `vscode`).
 */

/**
 * Escape a string so it is safe to embed inside a double-quoted XML
 * attribute. Encodes `&`, `"`, and `<`. Used for binlog paths inserted
 * into the system-prompt context block.
 */
export function escapeAttr(s: string): string {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;');
}

/**
 * Escape text content embedded between XML-style wrapper tags such as
 * `<user_request>...</user_request>` or `<buildcheck>...</buildcheck>`.
 *
 * Prevents prompt injection where a user message or tool output that
 * contains a closing tag like `</user_request>` would let the content
 * escape its wrapper and inject prompt fragments interpreted as system
 * instructions.
 */
export function escapeXmlText(s: string): string {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
