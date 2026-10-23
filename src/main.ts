
import { applyHfTokenHeader, DatasetMetadata, fetchMetadata, fetchMotionTree, getHfToken, PartNetMobilityModel, setHfToken } from './api';
import { PartTree } from './part-tree';
import { QJoint, Viewer3D } from './viewer3d';

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

const NO_PREVIEW_PLACEHOLDER =
  'data:image/svg+xml;utf8,' +
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 3">' +
  '<rect width="4" height="3" fill="%23dddddd"/></svg>';

const statusEl = el('status');

function setStatus(message: string, isError = false) {
  statusEl.textContent = message;
  statusEl.className = isError ? 'error' : '';
}

function buildJointControls(joints: QJoint[], onJointChange: (j: QJoint, v: number) => void) {
  const container = el('joints');
  container.innerHTML = '';
  if (!joints.length) {
    container.className = 'muted';
    container.textContent = 'This model has no articulated joints.';
    return;
  }
  container.className = '';
  joints.forEach(joint => {
    const row = document.createElement('div');
    row.className = 'joint-row';

    const label = document.createElement('div');
    label.className = 'joint-label';
    const name = document.createElement('span');
    name.textContent = joint.name;
    const value = document.createElement('span');
    value.textContent = joint.value.toFixed(2);
    label.appendChild(name);
    label.appendChild(value);

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = String(joint.low);
    slider.max = String(joint.high);
    slider.step = String(Math.max((joint.high - joint.low) / 100, 0.001));
    slider.value = String(joint.value);
    slider.addEventListener('input', () => {
      const v = parseFloat(slider.value);
      value.textContent = v.toFixed(2);
      onJointChange(joint, v);
    });

    row.appendChild(label);
    row.appendChild(slider);
    container.appendChild(row);
  });
}

async function main() {
  applyHfTokenHeader();
  const canvas = el<HTMLCanvasElement>('render-canvas');
  const viewer = new Viewer3D(canvas);
  const partTree = new PartTree(el('part-tree'), {
    onHover: meshes => viewer.setHighlight(meshes)
  });

  const tokenInput = el<HTMLInputElement>('hf-token');
  tokenInput.value = getHfToken();
  el('token-save').addEventListener('click', () => {
    setHfToken(tokenInput.value.trim());
    setStatus(getHfToken() ? 'HuggingFace token saved.' : 'HuggingFace token cleared.');
    loadMetadata();
  });
  el('token-clear').addEventListener('click', () => {
    tokenInput.value = '';
    setHfToken('');
    setStatus('HuggingFace token cleared.');
    loadMetadata();
  });

  const categorySelect = el<HTMLSelectElement>('category');
  const searchInput = el<HTMLInputElement>('search');
  const listEl = el('model-list');
  const countEl = el('model-count');
  const infoEl = el('model-info');

  let metadata: DatasetMetadata;
  let activeItem: HTMLElement | null = null;

  const matches = (m: PartNetMobilityModel, query: string) =>
    !query || String(m.id).includes(query) || m.model.toLowerCase().includes(query);

  const loadModel = async (m: PartNetMobilityModel) => {
    setStatus(`Loading model ${m.id} ...`);
    try {
      const { nodes, resultTree } = await fetchMotionTree(m.id);
      await viewer.loadModel(m.id, nodes);
      partTree.setData(resultTree, viewer.objMeshes);
      buildJointControls(viewer.qjoints, (j, v) => viewer.jointChange(j, v));
      infoEl.textContent = `#${m.id} · ${m.cat} · model ${m.model} · version ${m.version}` +
        `${m.original ? ' · original (unremeshed)' : ''}`;
      setStatus('');
    } catch (e) {
      setStatus(`Failed to load model ${m.id}: ${(e as Error).message}`, true);
    }
  };

  const selectModel = (m: PartNetMobilityModel, cell: HTMLElement | null) => {
    if (activeItem) {
      activeItem.classList.remove('active');
    }
    if (cell) {
      cell.classList.add('active');
      activeItem = cell;
    }
    loadModel(m);
  };

  const renderList = () => {
    const cat = categorySelect.value;
    const query = searchInput.value.trim().toLowerCase();
    const models = metadata.models.filter(m =>
      (!cat || m.cat === cat) && matches(m, query));

    listEl.innerHTML = '';
    countEl.textContent = `${models.length} model${models.length === 1 ? '' : 's'}`;
    activeItem = null;
    models.forEach(m => {
      const cell = document.createElement('div');
      cell.className = 'model-cell';
      cell.dataset.id = String(m.id);
      cell.title = `#${m.id} · ${m.cat}`;

      const img = document.createElement('img');
      img.loading = 'lazy';
      img.alt = `model ${m.id}`;
      img.src = `previews/${m.id}.webp`;
      img.addEventListener('error', () => {
        img.src = NO_PREVIEW_PLACEHOLDER;
      }, { once: true });

      const caption = document.createElement('div');
      caption.className = 'cell-id';
      caption.textContent = `#${m.id}`;

      cell.appendChild(img);
      cell.appendChild(caption);
      cell.addEventListener('click', () => selectModel(m, cell));
      listEl.appendChild(cell);
    });
  };

  const loadMetadata = async () => {
    try {
      metadata = await fetchMetadata();
    } catch (e) {
      setStatus(`Failed to load dataset metadata: ${(e as Error).message}`, true);
      return;
    }
    const categories = metadata.categories.map(c => c.cat).sort();
    categorySelect.innerHTML = '';
    const allOption = document.createElement('option');
    allOption.value = '';
    allOption.textContent = `All categories (${metadata.models.length})`;
    categorySelect.appendChild(allOption);
    categories.forEach(cat => {
      const option = document.createElement('option');
      option.value = cat;
      const count = metadata.categories.find(c => c.cat === cat)?.count ?? 0;
      option.textContent = `${cat} (${count})`;
      categorySelect.appendChild(option);
    });
    renderList();
    setStatus('');
  };

  categorySelect.addEventListener('change', renderList);
  searchInput.addEventListener('input', renderList);
  await loadMetadata();

  const wanted = new URLSearchParams(location.search).get('model');
  if (wanted && metadata) {
    const m = metadata.models.find(x => String(x.id) === wanted);
    if (m) {
      const cell = listEl.querySelector(`.model-cell[data-id="${m.id}"]`) as HTMLElement | null;
      selectModel(m, cell);
    }
  }
}

main();
