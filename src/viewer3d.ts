
import * as BABYLON from 'babylonjs';
import 'babylonjs-loaders';
import { getApiUrl, MotionTreeNode, PartRef } from './api';

export interface QJoint {
  name: string;
  node: MotionTreeNode;
  idx: 0 | 1;
  low: number;
  high: number;
  inverted: boolean;
  value: number;
}

function updateNormals(mesh: BABYLON.AbstractMesh) {
  if (mesh instanceof BABYLON.Mesh) {
    mesh.convertToFlatShadedMesh();
    const positions = mesh.getVerticesData(BABYLON.VertexBuffer.PositionKind);
    const indices = mesh.getIndices();
    const normals = [];
    BABYLON.VertexData.ComputeNormals(positions, indices, normals, {});
    mesh.setVerticesData(BABYLON.VertexBuffer.NormalKind, normals);
  }
}

export class Viewer3D {
  engine: BABYLON.Engine;
  scene: BABYLON.Scene;
  camera: BABYLON.ArcRotateCamera;

  motionTree?: MotionTreeNode;
  qjoints: QJoint[] = [];
  objMeshes = new Map<string, BABYLON.AbstractMesh[]>();

  private modelMeshes: BABYLON.AbstractMesh[] = [];
  private highlighted: { mesh: BABYLON.AbstractMesh, emissive: BABYLON.Color3 }[] = [];

  constructor(private canvas: HTMLCanvasElement) {
    this.engine = new BABYLON.Engine(this.canvas, true);
    this.scene = new BABYLON.Scene(this.engine);
    this.scene.useRightHandedSystem = true;
    this.scene.clearColor = new BABYLON.Color4(0.8, 0.8, 0.8, 1);

    const light1 = new BABYLON.HemisphericLight('light', new BABYLON.Vector3(0, 1, 0), this.scene);
    light1.intensity = 0.8;

    this.setupCamera('pers');

    this.engine.runRenderLoop(() => {
      this.camera.minZ = 0.1;
      this.camera.maxZ = 1000;
      this.scene.render();
    });
    window.addEventListener('resize', () => this.engine.resize());
  }

  setupCamera(type: 'ortho' | 'pers') {
    this.camera = new BABYLON.ArcRotateCamera('Camera', 0, 0, 10, new BABYLON.Vector3(0, 0, 0), this.scene);
    this.camera.attachControl(this.canvas, false);
    this.camera.position = new BABYLON.Vector3(2, 2, 2);
    this.camera.wheelPrecision = 20;
    this.camera.lowerRadiusLimit = 1;
    this.camera.upperRadiusLimit = 20;
    this.camera.radius = 8;

    if (type === 'ortho') {
      this.camera.minZ = 0.1;
      this.camera.maxZ = 1000;
    } else {
      this.camera.mode = BABYLON.Camera.PERSPECTIVE_CAMERA;

      this.camera.fov = 0.4;
      this.camera.minZ = 0.1;
      this.camera.maxZ = 1000;
    }
  }

  clearModel() {
    this.setHighlight(null);
    this.modelMeshes.forEach(m => m.dispose());
    this.modelMeshes = [];
    this.objMeshes.clear();
    this.motionTree = undefined;
    this.qjoints = [];
  }

  async loadModel(id: number, nodes: MotionTreeNode[]): Promise<MotionTreeNode> {
    this.clearModel();

    const requests: Promise<void>[] = [];
    const objMeshes = this.objMeshes;
    const loadPart = (part: PartRef) => {
      (part.objs || []).forEach(obj => {
        requests.push(
          BABYLON.SceneLoader
            .ImportMeshAsync('', getApiUrl() + `/data/dataset/${id}/textured_objs/`,
              obj + '.obj', this.scene)
            .then(({ meshes }) => {
              meshes.forEach(mesh => {
                updateNormals(mesh);
                BABYLON.Tags.EnableFor(mesh);
                BABYLON.Tags.AddTagsTo(mesh, 'type:object');
                if (mesh.material) {
                  mesh.material.backFaceCulling = true;
                } else {
                  const material = new BABYLON.StandardMaterial('', this.scene);
                  material.emissiveColor = new BABYLON.Color3(100, 0, 100);
                  mesh.material = material;
                }
                this.modelMeshes.push(mesh);
                const list = objMeshes.get(obj) || [];
                list.push(mesh);
                objMeshes.set(obj, list);
              });
              part.meshes.push(...meshes);
            }).catch(err => {
              console.warn(`failed to load mesh ${obj} of model ${id}:`, err);
            })
        );
      });
    };

    nodes.forEach(node => {

      node.parts.forEach(p => p.meshes = []);
      if (node.joint === 'junk') {
        return;
      }
      node.parts.forEach(loadPart);
    });
    await Promise.all(requests);

    nodes.forEach(n => n.children = []);
    nodes.forEach(n => {
      if (n.parent >= 0) {
        nodes[n.parent].children.push(n);
      }
    });
    const roots = nodes.filter(n => n.parent < 0 && n.joint !== 'junk');
    if (roots.length !== 1) {
      throw new Error(`invalid model ${id}: expected one root, found ${roots.length}`);
    }
    this.motionTree = roots[0];

    this.qjoints = [];
    (function fillJoints(node: MotionTreeNode, qjoints: QJoint[]) {
      node.data = { pose: BABYLON.Matrix.Identity(), joints: [] };

      if (node.joint === 'hinge' ||
        (node.joint === 'slider' && !node.jointData.limit.rotates)) {
        let limited = !node.jointData.limit.noLimit;
        let a = node.jointData.limit.a;
        let b = node.jointData.limit.b;
        let inverted = false;
        let init = a;
        let name = node.name;
        const mv = (node.joint === 'slider' ? 10 : 360);
        if (node.joint === 'hinge') {
          name += ' (revolute)';
        } else {
          name += ' (prismatic)';
        }
        if (!limited) {
          a = -mv;
          b = mv;
          init = 0;
        }
        if (a > b) {
          inverted = true;
          a = -a;
          b = -b;
          init = a;
        }
        qjoints.push({ name, node, idx: 0, low: a, high: b, inverted, value: init });
        node.data.joints = [qjoints[qjoints.length - 1]];
      } else if (node.joint === 'slider' && node.jointData.limit.rotates) {
        let limited = !node.jointData.limit.noLimit;
        let a = node.jointData.limit.a;
        let b = node.jointData.limit.b;
        let inverted = false;
        let init = a;
        const mv = 10;
        if (!limited) {
          a = -mv;
          b = mv;
          init = 0;
        }
        if (a > b) {
          inverted = true;
          a = -a;
          b = -b;
          init = a;
        }
        qjoints.push({
          name: node.name + ' (prismatic)',
          node, idx: 0, low: a, high: b, inverted, value: init
        });
        qjoints.push({
          name: node.name + ' (revolute)',
          node, idx: 1, low: -180, high: 180, inverted: false, value: 0
        });
        node.data.joints = [
          qjoints[qjoints.length - 2],
          qjoints[qjoints.length - 1]
        ];
      }
      node.children && node.children.length && node.children.forEach(c => fillJoints(c, qjoints));
    })(this.motionTree, this.qjoints);

    await Promise.race([
      this.scene.whenReadyAsync(),
      new Promise(resolve => setTimeout(resolve, 8000)),
    ]);

    this.forward();
    this.frameModel();
    return this.motionTree;
  }

  frameModel() {
    if (!this.modelMeshes.length) {
      return;
    }
    const min = new BABYLON.Vector3(Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE);
    const max = new BABYLON.Vector3(-Number.MAX_VALUE, -Number.MAX_VALUE, -Number.MAX_VALUE);
    this.modelMeshes.forEach(m => {
      m.computeWorldMatrix(true);
      m.getBoundingInfo().update(m.getWorldMatrix());
      const bb = m.getBoundingInfo().boundingBox;
      min.x = Math.min(min.x, bb.minimumWorld.x);
      min.y = Math.min(min.y, bb.minimumWorld.y);
      min.z = Math.min(min.z, bb.minimumWorld.z);
      max.x = Math.max(max.x, bb.maximumWorld.x);
      max.y = Math.max(max.y, bb.maximumWorld.y);
      max.z = Math.max(max.z, bb.maximumWorld.z);
    });
    const center = max.add(min).scale(0.5);

    const radius = Math.max(max.subtract(min).length() / 2, 1e-3);

    const halfV = this.camera.fov / 2;
    const halfH = Math.atan(Math.tan(halfV) * this.engine.getAspectRatio(this.camera));
    const distance = (radius / Math.sin(Math.min(halfV, halfH))) * 1.25;

    this.camera.target = center;
    this.camera.radius = distance;
    this.camera.lowerRadiusLimit = radius * 0.3;
    this.camera.upperRadiusLimit = distance * 8;
    this.camera.minZ = Math.max(distance - radius * 1.5, distance / 200);
    this.camera.maxZ = distance + radius * 8;
  }

  jointChange(joint: QJoint, value: number) {
    joint.value = value;
    this.forward();
  }

  forward() {
    if (!this.motionTree) {
      return;
    }

    (function forward(node: MotionTreeNode, parentPose: BABYLON.Matrix) {
      let pose = parentPose;
      if (node.data.joints.length === 0) {

      } else if (node.data.joints.length === 1) {
        const value = node.data.joints[0].value * (node.data.joints[0].inverted ? -1 : 1);
        const [x, y, z] = node.jointData.axis.origin;
        const origin = new BABYLON.Vector3(x, y, z);
        const [dx, dy, dz] = node.jointData.axis.direction;
        const direction = new BABYLON.Vector3(dx, dy, dz);

        if (node.joint === 'hinge') {
          const matTranslation1 = BABYLON.Matrix.Identity();
          matTranslation1.setTranslation(origin);
          const matRotation = BABYLON.Matrix.Identity();
          BABYLON.Quaternion.RotationAxis(direction,
            (Math.PI * value) / 180.0).toRotationMatrix(matRotation);
          const matTranslation2 = BABYLON.Matrix.Identity();
          matTranslation2.setTranslation(origin.scale(-1));
          pose = matTranslation2.multiply(matRotation).multiply(matTranslation1).multiply(parentPose);
        } else {
          let transVec = direction.normalize();
          transVec = transVec.scale(value);
          const matTranslation1 = BABYLON.Matrix.Identity();
          matTranslation1.setTranslation(transVec);
          pose = matTranslation1.multiply(parentPose);
        }
      } else {
        const [x, y, z] = node.jointData.axis.origin;
        const origin = new BABYLON.Vector3(x, y, z);
        const [dx, dy, dz] = node.jointData.axis.direction;
        const direction = new BABYLON.Vector3(dx, dy, dz);

        const value1 = node.data.joints[0].value * (node.data.joints[0].inverted ? -1 : 1);

        const value2 = node.data.joints[1].value * (node.data.joints[0].inverted ? -1 : 1);

        const matTranslation1 = BABYLON.Matrix.Identity();
        matTranslation1.setTranslation(origin);
        const matRotation = BABYLON.Matrix.Identity();
        BABYLON.Quaternion.RotationAxis(direction,
          (Math.PI * value2) / 180.0).toRotationMatrix(matRotation);
        const matTranslation2 = BABYLON.Matrix.Identity();
        matTranslation2.setTranslation(origin.scale(-1));

        let transVec = direction.normalize();
        transVec = transVec.scale(value1);
        const matTranslation3 = BABYLON.Matrix.Identity();
        matTranslation3.setTranslation(transVec);

        pose = matTranslation3.multiply(matTranslation2)
          .multiply(matRotation).multiply(matTranslation1).multiply(parentPose);
      }

      const scale = new BABYLON.Vector3();
      const rotation = BABYLON.Quaternion.Identity();
      const translation = new BABYLON.Vector3();
      pose.decompose(scale, rotation, translation);

      node.parts.forEach(p => p.meshes.forEach(m => {
        m.rotationQuaternion = rotation;
        m.position = translation;
      }));

      node.children && node.children.length && node.children.forEach(c => forward(c, pose));
    })(this.motionTree, BABYLON.Matrix.Identity());
  }

  setHighlight(meshes: BABYLON.AbstractMesh[] | null) {
    this.highlighted.forEach(({ mesh, emissive }) => {
      if (mesh.material instanceof BABYLON.StandardMaterial) {
        mesh.material.emissiveColor = emissive;
      }
    });
    this.highlighted = [];
    if (meshes) {
      meshes.forEach(mesh => {
        if (mesh.material instanceof BABYLON.StandardMaterial) {
          this.highlighted.push({ mesh, emissive: mesh.material.emissiveColor.clone() });
          mesh.material.emissiveColor = new BABYLON.Color3(1, 0.5, 0);
        }
      });
    }
  }

  setMeshesVisible(meshes: BABYLON.AbstractMesh[], visible: boolean) {
    meshes.forEach(m => m.setEnabled(visible));
  }
}
