
import * as BABYLON from 'babylonjs';

export interface PartNetMobilityModel {
  id: number;
  model: string;
  cat: string;
  original: number;
  version: string;
}

export interface CategoryCount {
  cat: string;
  count: number;
}

export interface PartRef {
  id: number;
  name: string;
  objs?: string[];
  meshes: BABYLON.AbstractMesh[];
}

export interface MotionTreeNode {
  id: number;
  joint: 'free' | 'heavy' | 'static' | 'slider' | 'hinge' | 'junk';
  name: string;
  parent: number;
  parts: PartRef[];
  jointData: {
    axis: {
      direction: [number, number, number];
      origin: [number, number, number];
    };
    limit: {
      a: number;
      b: number;
      noLimit: boolean;

      rotates: boolean;
      noRotationLimit: boolean;
      rotationLimit: number;
    };
  };
  children?: MotionTreeNode[];
  data: any;
}

export interface ResultNode {
  id: number;
  name: string;
  text?: string;
  objs?: string[];
  children?: ResultNode[];
}

export interface DatasetMetadata {
  categories: CategoryCount[];
  models: PartNetMobilityModel[];
}

export function getApiUrl(): string {

  return document.baseURI.replace(/[?#].*$/, '').replace(/[^/]*$/, '') + 'api';
}

const TOKEN_STORAGE_KEY = 'pmv-hf-token';

export function getHfToken(): string {
  return localStorage.getItem(TOKEN_STORAGE_KEY) || '';
}

export function setHfToken(token: string) {
  if (token) {
    localStorage.setItem(TOKEN_STORAGE_KEY, token);
  } else {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
  }
  applyHfTokenHeader();
}

export function applyHfTokenHeader() {
  const token = getHfToken();
  const set = (headers: { [key: string]: string }) => {
    if (token) {
      headers['X-HF-Token'] = token;
    } else {
      delete headers['X-HF-Token'];
    }
  };
  set(BABYLON.WebRequest.CustomRequestHeaders);
  set(BABYLON.Tools.CustomRequestHeaders);
  BABYLON.Tools.UseCustomRequestHeaders = !!token;
}

function authHeaders(): { [key: string]: string } {
  const token = getHfToken();
  return token ? { 'X-HF-Token': token } : {};
}

export async function fetchMetadata(): Promise<DatasetMetadata> {
  return fetchJson<DatasetMetadata>(getApiUrl() + '/metadata');
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) {
    const message = await res.text().catch(() => '');
    throw new Error(message || `request failed: ${res.status} ${url}`);
  }
  return res.json();
}

export function fetchResultTree(id: number): Promise<ResultNode[]> {
  return fetchJson<ResultNode[]>(getApiUrl() + `/data/dataset/${id}/result.json`);
}

export async function fetchMotionTree(id: number):
  Promise<{ nodes: MotionTreeNode[], resultTree: ResultNode[] }> {
  const nodes = await fetchJson<MotionTreeNode[]>(getApiUrl() + `/data/dataset/${id}/mobility_v2.json`);
  const tree = await fetchResultTree(id);
  const id2obj = new Map<number, string[]>();
  tree.forEach(function find(node: ResultNode) {
    if (node.objs) {
      id2obj.set(node.id, node.objs);
    }
    if (node.children) {
      node.children.forEach(find);
    }
  });
  nodes.forEach(n => n.parts.forEach(p => p.objs = id2obj.get(p.id)));
  return { nodes, resultTree: tree };
}
