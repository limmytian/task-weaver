# Identity tokens

Task Weaver uses the approved weave with, indigo and blue. The equal strands represent shared contribution; strand color does not identify a human, agent, permission or task state.

`tokens.json` is the reference for opaque sRGB light/dark values. `tokens.css` maps these to existing shadcn/Tailwind custom properties under an explicit `.tw-brand` scope. The Web stylesheet applies a synchronized copy in apps/web/app/brand.css on the root body. Semantic destructive/success/warning, chart and task-status colors remain separate. Secondary brand blue belongs to identity and restrained accents, not success indicators.

Run `node design/brand/identity/verify.mjs` to verify all token mappings and 34 contrast pairs. Text pairs meet 4.5:1 and essential graphics, input boundaries and focus rings meet 3:1 for the documented backgrounds. These checks do not establish complete WCAG conformance: actual component states, overlays and keyboard interactions require product-level validation. Never place these colors over arbitrary imagery without retesting.

Typography remains Geist Sans for UI and prose, Geist Mono for code, identifiers and technical values. Use existing application font variables. Suggested roles: page title 24/32 at 600; section title 18/28 at 600; body 14/20 at 400; label 12/16 at 500; code 13/20. Keep dense task tables readable and allow text zoom. The editable logo wordmark uses Geist SemiBold. Existing font license accompanies logo exports.

Retain the existing Lucide outline icon vocabulary and consistent stroke weight. Illustrations may use simple intersecting paths and neutral framing; avoid robot/human hierarchy, decorative helixes and intricate knots. Status distinctions always include labels or recognizable icons. Recognition must not depend on animation; respect reduced-motion settings.
