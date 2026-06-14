# Lucide icons (vendored path data)

The inner SVG markup in `web/src/ui/icons.ts` is vendored from
lucide-static v1.17.0 (https://lucide.dev, ISC license — see LICENSE
here). Each entry is the inner content of the icon's published SVG,
verbatim; the `<svg>` wrapper (viewBox 0 0 24 24, stroke=currentColor,
fill=none, round caps/joins) is reconstructed by `icon()` at runtime
with a slightly lighter stroke-width (1.75 vs upstream's 2).

Vendored icons: mail, moon, sun, info, circle-help, pencil, ellipsis,
x, chevron-left, chevron-right, chevron-down, chevron-up, arrow-up,
arrow-down, grip-vertical, calendar, search, check, plus, refresh-cw,
circle-user, list-filter, sliders-horizontal, paintbrush, list-tree.

To add an icon: fetch `https://unpkg.com/lucide-static@<ver>/icons/<name>.svg`,
strip the comment banner and `<svg>` wrapper, collapse whitespace, add
the entry to `ICON_MARKUP`, and list the name here.
