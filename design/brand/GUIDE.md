# Task Weaver brand guide

Task Weaver is a shared workspace where humans and AI agents collaborate as equal participants. Connect requirements, tasks and knowledge through clear, accountable work. Keep the Task Weaver name and describe actual capabilities precisely.

## Identity and tone

The selected A mark uses two equally weighted paths weaving over and under each other. Preserve both paths, their crossing gaps and their open ends. The selected palette is 02, indigo and blue. Selection applies to geometry and palette; product-level visual acceptance follows application integration.

Use calm, capable and approachable language. Prefer concrete verbs and useful context. Explain who acted and what changed without claiming autonomous authority that the product does not grant. Avoid magic, superhuman speed, surveillance, robot mascots and human-over-agent hierarchy.

Canonical descriptor: “A shared workspace for humans and AI agents.” Supporting line: “Connect requirements, tasks and knowledge.” “Build together.” is an optional presentation headline, not a replacement for an informative product description. CLI help remains plain, readable text; retain command names, flags, machine JSON and technical descriptions. Do not add a decorative terminal banner by default.

## Logo

Use the SVG masters in [logo](logo/README.md). Use the full horizontal wordmark where space permits and the standalone mark for navigation and favicons. Minimum mark size is 16 px; prefer 24 px or larger. Minimum wordmark width is 150 px. Keep at least 8 master units of clear space beyond the visible artwork; placement containers must supply it. Transparent PNG and ICO exports are catalogued in [the manifest](logo/manifest.json).

Use the light variant on white/light neutral backgrounds, dark on dark neutral backgrounds, ink for one-color light-background applications and white for one-color dark-background applications. Do not stretch, rotate, flatten crossings, independently change strand weights, add shadows or gradients, or place the mark on visually busy backgrounds. A is the selected identity; B–G and other explorations remain historical candidates and must not be presented as approved alternatives. Do not use strand colors to encode roles or access rights.

## Color and typography

| Role | Light | Dark |
| --- | --- | --- |
| Primary indigo | `#4f46e5` | `#a5b4fc` |
| Secondary identity blue | `#0369a1` | `#7dd3fc` |
| Primary foreground | `#ffffff` | `#111827` |
| Body foreground | `#17212b` | `#f8fafc` |
| Background | `#ffffff` | `#111827` |

The complete mapping is in [tokens.json](identity/tokens.json), with opt-in shadcn-compatible [CSS](identity/tokens.css). Preserve semantic destructive/success/warning, chart and task-status mappings. Use primary indigo for actions and links; reserve blue for restrained identity accents. Keep most workspace surfaces neutral and preserve information density.

Use the existing Geist Sans and Geist Mono fonts. Sans covers UI/prose and Mono covers code/identifiers. Typography roles and icon/illustration guidance are in [identity/README.md](identity/README.md). Lucide outline icons remain the product vocabulary. No new font service or third-party image library is needed.

## Accessibility and states

[contrast.json](identity/contrast.json) records 34 opaque sRGB pairs. Normal text targets at least 4.5:1; essential graphics, input borders and focus rings target at least 3:1 against the documented backgrounds. Run `node design/brand/identity/verify.mjs` to check these pairs and CSS mappings. These checks cover the specified combinations, not every application component or complete WCAG conformance.

Keep visible keyboard focus, underline links, and pair status color with labels/icons. Preserve error text and accessible names when adding marks. Use an empty image alternative when adjacent text already names Task Weaver; give a standalone home link an accessible product name. Respect reduced motion and text zoom. Validate disabled, hover, selected, overlay and loading states during integration. Retest any different background or opacity combination.

## Reusable templates

[templates](templates/README.md) contains editable 1280×640 social artwork, 960×240 README headers in light/dark themes, and a 1440×1000 screenshot frame. Copy and edit the source templates; preserve the originals and their license notice. Social and README text remains editable with embedded Geist SemiBold.

The screenshot frame is explicitly a placeholder. Insert only current, sanitized screenshots with no credentials, private accounts, workspace names or infrastructure details. Label actual version/theme and feature; do not present mockups as shipped product evidence. Exported raster copies must be visually checked for text layout and font rendering.

Preparing assets does not upload them to GitHub, change a public repository profile, publish a site, create a release or deploy a product. Integration of Web/CLI/README surfaces is tracked separately; release inclusion remains an owner decision.

## Provenance

Logo geometry is original project artwork. Geist fonts retain their accompanying SIL Open Font License in logo/templates and the existing candidate font directory. SVG source contains no scripts or external fetch dependencies; font data is embedded. Repository LICENSE, NOTICE and TRADEMARKS.md continue to apply. No registration, exclusivity or trademark clearance claim is made.
