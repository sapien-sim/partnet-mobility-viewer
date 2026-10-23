
import * as BABYLON from 'babylonjs';
import { ResultNode } from './api';

interface Row {
  node: ResultNode;
  depth: number;
  children: Row[];
  meshes: BABYLON.AbstractMesh[];
  checked: boolean;
  expanded: boolean;
  rowEl: HTMLElement;
}

export class PartTree {
  private rows: Row[] = [];
  private onHover: (meshes: BABYLON.AbstractMesh[] | null) => void;

  constructor(private container: HTMLElement,
    opts: { onHover: (meshes: BABYLON.AbstractMesh[] | null) => void }) {
    this.onHover = opts.onHover;
  }

  clear() {
    this.rows = [];
    this.container.innerHTML = '';
    this.onHover(null);
  }

  setData(roots: ResultNode[], objMeshes: Map<string, BABYLON.AbstractMesh[]>) {
    this.clear();

    const collect = (node: ResultNode, out: BABYLON.AbstractMesh[]) => {
      (node.objs || []).forEach(o => {
        const meshes = objMeshes.get(o);
        if (meshes) {
          out.push(...meshes);
        }
      });
      (node.children || []).forEach(c => collect(c, out));
    };

    const build = (node: ResultNode, depth: number): Row => {
      const meshes: BABYLON.AbstractMesh[] = [];
      collect(node, meshes);
      const row: Row = {
        node, depth, meshes,
        children: (node.children || []).map(c => build(c, depth + 1)),
        checked: true, expanded: true, rowEl: null
      };
      return row;
    };

    this.rows = roots.map(r => build(r, 0));
    this.rows.forEach(r => this.renderRow(r));
  }

  private renderRow(row: Row) {
    const el = document.createElement('div');
    el.className = 'tree-row';
    el.style.paddingLeft = `${8 + row.depth * 16}px`;

    const toggle = document.createElement('button');
    toggle.className = 'tree-toggle';
    toggle.textContent = row.children.length ? (row.expanded ? '▾' : '▸') : ' ';
    toggle.addEventListener('click', () => {
      row.expanded = !row.expanded;
      toggle.textContent = row.expanded ? '▾' : '▸';
      this.updateRowVisibility();
    });
    el.appendChild(toggle);

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = row.checked;
    checkbox.addEventListener('change', () => {
      row.checked = checkbox.checked;
      this.applyVisibility(row, row.checked ? true : false);
    });
    el.appendChild(checkbox);

    const label = document.createElement('span');
    label.className = 'tree-label';
    label.textContent = row.node.name || row.node.text || `part ${row.node.id}`;
    label.title = `${row.node.name} (${row.meshes.length} meshes)`;
    el.appendChild(label);

    el.addEventListener('mouseenter', () => this.onHover(row.meshes));
    el.addEventListener('mouseleave', () => this.onHover(null));

    row.rowEl = el;
    this.container.appendChild(el);
    row.children.forEach(c => this.renderRow(c));
  }

  private applyVisibility(row: Row, visible: boolean) {
    row.meshes.forEach(m => m.setEnabled(visible));
    row.children.forEach(c => this.applyVisibility(c, visible));
  }

  private updateRowVisibility() {
    const walk = (row: Row, shown: boolean) => {
      row.rowEl.style.display = shown ? '' : 'none';
      row.children.forEach(c => walk(c, shown && row.expanded));
    };
    this.rows.forEach(r => walk(r, true));
  }
}
