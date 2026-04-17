# ADR-004: Embed Strategy — Web Component with Shadow DOM

**Date**: 2026-04-16
**Status**: Accepted
**Deciders**: Project team

## Context

The widget must be embeddable on any website with minimal integration effort. The embedding mechanism must:
- Work with a single `<script>` tag
- Not leak styles into or absorb styles from the host page
- Accept configuration (at minimum, the proxy URL)
- Work regardless of the host site's framework (WordPress, React, static HTML, etc.)

## Decision

Distribute the widget as a **Web Component** (`<voter-info-widget>`) using **Shadow DOM** for style isolation, built as a single **IIFE** (Immediately Invoked Function Expression) JavaScript file.

```html
<script src="https://cdn.example.com/voter-info-widget.iife.js"></script>
<voter-info-widget api-base="https://proxy.example.com"></voter-info-widget>
```

## Rationale

**Web Components**: Native browser API — no framework required on the host site. The `customElements.define()` API is supported in all modern browsers (Chrome, Firefox, Safari, Edge — last 2+ years of versions). The element behaves like any HTML tag.

**Shadow DOM**: Creates an isolated DOM tree with its own CSS scope. Host site styles cannot bleed into the widget, and widget styles cannot affect the host. This is critical for an embeddable component — without it, CSS conflicts are inevitable.

**IIFE build**: A single file with no external imports. The embedder includes one `<script>` tag. No module bundler, no import maps, no build step required on the host site. Vite's library build mode supports IIFE output natively.

**Configuration via attributes**: The `api-base` attribute is read in `connectedCallback()`. HTML attributes are the standard configuration mechanism for custom elements — no JavaScript API required.

## Implementation

```typescript
class VoterInfoElement extends HTMLElement {
  connectedCallback() {
    const shadow = this.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = WIDGET_CSS;
    shadow.appendChild(style);
    const root = document.createElement('div');
    shadow.appendChild(root);
    createRoot(root).render(
      <VoterInfoWidget apiBase={this.getAttribute('api-base') || ''} />
    );
  }
}
customElements.define('voter-info-widget', VoterInfoElement);
```

Vite build config:
```typescript
build: {
  lib: {
    entry: 'src/embed.tsx',
    name: 'VoterInfoWidget',
    fileName: 'voter-info-widget',
    formats: ['iife'],
  },
  cssCodeSplit: false, // CSS inlined into JS via import
}
```

## Alternatives Considered

| Alternative | Why Not |
|------------|---------|
| iframe embed | Heavy (full page load), hard to make responsive, cross-origin communication is clunky |
| React render function | Requires host site to have React; not framework-agnostic |
| ES module export | Requires import maps or bundler on host site; higher integration bar |
| CSS-in-JS (no Shadow DOM) | Style isolation is not guaranteed; specificity wars with host CSS |

## Consequences

- React renders inside Shadow DOM — some React patterns (portals, global event listeners) need adaptation
- CSS must be inlined as a string (Vite handles this with `?inline` import)
- Shadow DOM adds ~1-2KB to the approach vs bare DOM
- Bundle includes React runtime (~40KB gzipped) — acceptable for the functionality provided
- IE11 not supported (Shadow DOM requires polyfill) — per spec, only modern browsers targeted
