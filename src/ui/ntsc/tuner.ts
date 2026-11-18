import { Kind, type NtscDescriptor, type NtscFilter, type NtscPreset } from './index';

/** Live tuning panel for the composite filter — the sliders from web.ntsc.rs,
 *  but over the running title screen so the temporal artifacts (head-switching
 *  tear, tracking noise, edge wave) can be judged against real motion.
 *
 *  Every control is generated from `filter.schema()`; nothing here knows the
 *  name of a single setting. This is a dev tool, not game UI: Title.tsx only
 *  loads it under import.meta.env.DEV so it never reaches a build. */
export class NtscTuner {
  private readonly root: HTMLElement;
  private readonly readout: HTMLElement;
  private rafId = 0;

  constructor(
    private readonly filter: NtscFilter,
    private settings: NtscPreset,
  ) {
    this.root = el('div', 'ntsc-tuner');
    this.root.style.cssText = [
      'position:fixed', 'top:0', 'right:0', 'bottom:0', 'width:340px',
      'z-index:9999', 'overflow-y:auto', 'box-sizing:border-box', 'padding:10px 12px 40px',
      'background:rgba(14,16,22,.94)', 'color:#dfe4ee', 'backdrop-filter:blur(6px)',
      'font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace',
      'border-left:1px solid #2a3040', 'display:none',
    ].join(';');

    this.readout = el('div');
    this.readout.style.cssText = 'color:#8fa2c0;margin:6px 0 10px;font-size:10px';

    this.root.append(this.header(), this.readout);
    for (const d of this.filter.schema()) this.root.append(this.control(d));
    document.body.append(this.root);
  }

  get visible() { return this.root.style.display !== 'none'; }

  toggle() {
    const on = !this.visible;
    this.root.style.display = on ? 'block' : 'none';
    if (on) {
      const tick = () => {
        this.readout.textContent =
          `${this.filter.lastMs.toFixed(2)} ms/frame · ${this.filter.scale}x · ${this.filter.enabled ? 'on' : 'off'}`;
        this.rafId = requestAnimationFrame(tick);
      };
      tick();
    } else {
      cancelAnimationFrame(this.rafId);
    }
  }

  destroy() {
    cancelAnimationFrame(this.rafId);
    this.root.remove();
  }

  // ---- header ---------------------------------------------------------------

  private header() {
    const h = el('div');
    h.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;align-items:center';
    const title = el('strong', undefined, 'composite');
    title.style.cssText = 'margin-right:auto;font-size:12px;color:#fff';
    h.append(
      title,
      this.button('copy', async () => {
        await navigator.clipboard.writeText(JSON.stringify(this.settings));
        console.log('[ntsc] preset copied — paste into src/ui/ntsc/preset.json');
      }),
      this.button('1x/2x', () => { this.filter.scale = this.filter.scale === 1 ? 2 : 1; }),
      this.button('on/off', () => { this.filter.enabled = !this.filter.enabled; }),
      this.button('defaults', () => {
        this.settings = JSON.parse(this.filter.defaultPreset());
        this.apply();
        this.rebuild();
      }),
    );
    return h;
  }

  private button(label: string, onClick: () => void) {
    const b = el('button', undefined, label) as HTMLButtonElement;
    b.style.cssText =
      'background:#232a38;color:#cfd8e8;border:1px solid #39435a;border-radius:4px;' +
      'padding:3px 7px;cursor:pointer;font:inherit';
    b.onclick = onClick;
    return b;
  }

  private rebuild() {
    while (this.root.childNodes.length > 2) this.root.lastChild!.remove();
    for (const d of this.filter.schema()) this.root.append(this.control(d));
  }

  // ---- the generic renderer --------------------------------------------------

  private apply() {
    this.filter.setPreset(JSON.stringify(this.settings));
  }

  private set(id: string, v: number | boolean) {
    this.settings[id] = v;
    this.apply();
  }

  private control(d: NtscDescriptor, depth = 0): HTMLElement {
    const row = el('div');
    row.style.cssText = `margin:7px 0 7px ${depth * 10}px`;
    if (d.description) row.title = d.description;

    switch (d.kind) {
      case Kind.Group: {
        const on = this.settings[d.idName] !== false;
        const head = this.checkbox(d.label, on, (v) => {
          this.set(d.idName, v);
          kids.style.opacity = v ? '1' : '.35';
          kids.style.pointerEvents = v ? '' : 'none';
        });
        head.style.cssText = 'font-weight:600;color:#fff';
        const kids = el('div');
        kids.style.cssText =
          `border-left:1px solid #2a3040;margin-left:5px;padding-left:7px;opacity:${on ? 1 : 0.35}`;
        if (!on) kids.style.pointerEvents = 'none';
        for (const c of d.value.children ?? []) kids.append(this.control(c, 0));
        row.append(head, kids);
        return row;
      }

      case Kind.Boolean:
        row.append(this.checkbox(d.label, this.settings[d.idName] !== false, (v) => this.set(d.idName, v)));
        return row;

      case Kind.Enumeration: {
        row.append(this.label(d.label));
        const sel = el('select') as HTMLSelectElement;
        sel.style.cssText = fieldCss + ';width:100%';
        for (const o of d.value.options ?? []) {
          const opt = el('option', undefined, o.label) as HTMLOptionElement;
          opt.value = String(o.index);
          if (o.description) opt.title = o.description;
          sel.append(opt);
        }
        sel.value = String(this.settings[d.idName] ?? d.value.defaultValue);
        sel.onchange = () => this.set(d.idName, Number(sel.value));
        row.append(sel);
        return row;
      }

      // random_seed's range is the full i32 — a slider over 4.3 billion values
      // is useless, so it gets a number box and a reroll button instead.
      case Kind.IntRange:
        if ((d.value.max ?? 0) - (d.value.min ?? 0) > 10_000) {
          row.append(this.label(d.label));
          const box = this.number(Number(this.settings[d.idName] ?? 0), 1, (v) => this.set(d.idName, Math.round(v)));
          const roll = this.button('reroll', () => {
            const v = (Math.random() * 2 ** 31) | 0;
            box.value = String(v);
            this.set(d.idName, v);
          });
          const wrap = el('div');
          wrap.style.cssText = 'display:flex;gap:5px';
          box.style.flex = '1';
          wrap.append(box, roll);
          row.append(wrap);
          return row;
        }
        return this.slider(row, d, 1);

      case Kind.Percentage:
        return this.slider(row, { ...d, value: { ...d.value, min: 0, max: 1 } }, 0.001);

      case Kind.FloatRange:
      default:
        return this.slider(row, d, 0.001);
    }
  }

  private slider(row: HTMLElement, d: NtscDescriptor, step: number) {
    const min = d.value.min ?? 0;
    const max = d.value.max ?? 1;
    const cur = Number(this.settings[d.idName] ?? d.value.defaultValue);

    const head = el('div');
    head.style.cssText = 'display:flex;align-items:center;gap:6px';
    const name = this.label(d.label + (d.value.logarithmic ? ' ~' : ''));
    name.style.marginRight = 'auto';

    // The slider is linear even where ntsc-rs scales logarithmically (marked ~),
    // so the number box is the way to land an exact low value.
    const box = this.number(cur, step, (v) => { rng.value = String(v); this.set(d.idName, v); });
    box.style.width = '66px';
    head.append(name, box);

    const rng = el('input') as HTMLInputElement;
    rng.type = 'range';
    rng.min = String(min); rng.max = String(max); rng.step = String(step);
    rng.value = String(cur);
    rng.style.cssText = 'width:100%;accent-color:#6d9eeb;margin:2px 0 0';
    rng.oninput = () => { const v = Number(rng.value); box.value = String(v); this.set(d.idName, v); };

    row.append(head, rng);
    return row;
  }

  // ---- bits -----------------------------------------------------------------

  private label(text: string) {
    const l = el('div', undefined, text);
    l.style.cssText = 'color:#aab6ca';
    return l;
  }

  private number(value: number, step: number, onChange: (v: number) => void) {
    const n = el('input') as HTMLInputElement;
    n.type = 'number';
    n.step = String(step);
    n.value = String(value);
    n.style.cssText = fieldCss;
    n.onchange = () => { const v = Number(n.value); if (Number.isFinite(v)) onChange(v); };
    return n;
  }

  private checkbox(text: string, checked: boolean, onChange: (v: boolean) => void) {
    const l = el('label');
    l.style.cssText = 'display:flex;gap:6px;align-items:center;cursor:pointer';
    const c = el('input') as HTMLInputElement;
    c.type = 'checkbox';
    c.checked = checked;
    c.style.accentColor = '#6d9eeb';
    c.onchange = () => onChange(c.checked);
    l.append(c, document.createTextNode(text));
    return l;
  }
}

const fieldCss =
  'background:#1a2130;color:#dfe4ee;border:1px solid #39435a;border-radius:4px;' +
  'padding:2px 5px;font:inherit;box-sizing:border-box';

function el(tag: string, cls?: string, text?: string) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
