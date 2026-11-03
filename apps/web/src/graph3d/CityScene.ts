import {
  AmbientLight, BoxGeometry, BufferGeometry, Color, DirectionalLight, EdgesGeometry, Group,
  Line, LineBasicMaterial, LineDashedMaterial, LineSegments, Mesh, MeshBasicMaterial, MeshStandardMaterial, ShadowMaterial,
  NeutralToneMapping, OrthographicCamera, PCFShadowMap, PlaneGeometry, Raycaster, Scene, SphereGeometry,
  Vector2, Vector3, WebGLRenderer, type Material, type Object3D,
} from 'three';
import type { Mark } from '../state/store';
import { NODE_H, NODE_W, type Layout, type Point } from '../graph/layout';
import { dataRoleOf, isBroken } from '../graph/vocabulary';
import { reducedMotion } from '../graph/effects';
import { blockHeight, orientCamera, type CityAngle } from './projection';
import { animate, utils } from 'animejs';

export interface CityEmphasis { nodes: Set<string> | null; edges: Set<string> | null; soft: boolean }
interface Block { group: Group; surface: MeshStandardMaterial; outline: LineBasicMaterial; nodeId: string }
interface Track { line: Line; points: Vector3[]; length: number; hot: boolean }

function disposeObject(object: Object3D): void {
  object.traverse((child) => {
    const mesh = child as Mesh;
    mesh.geometry?.dispose();
    const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    materials.forEach((material: Material) => material.dispose());
  });
}

/** One full-bleed WebGL scene, synchronized with React Flow's viewport. */
export class CityScene {
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 30000);
  private readonly content = new Group();
  private readonly blocks = new Map<string, Block>();
  private readonly tracks = new Map<string, Track>();
  private readonly particles = new Group();
  private readonly raycaster = new Raycaster();
  private readonly light = new DirectionalLight(0xffffff, 2.1);
  private layout: Layout | null = null;
  private origin: Point = { x: 0, y: 0 };
  private width = 1;
  private height = 1;
  private viewport = { x: 0, y: 0, zoom: 1 };
  private frame = 0;
  private sweep = 0;
  private flow = false;
  private started = 0;
  private readonly color = (name: string) => new Color(getComputedStyle(this.host).getPropertyValue(`--color-${name}`).trim());

  constructor(private readonly host: HTMLDivElement) {
    this.renderer = new WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFShadowMap;
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.toneMapping = NeutralToneMapping;
    this.renderer.toneMappingExposure = 0.85;
    this.renderer.domElement.setAttribute('aria-hidden', 'true');
    this.renderer.domElement.className = 'city-canvas';
    this.host.appendChild(this.renderer.domElement);
    this.scene.add(new AmbientLight(0xffffff, 1.1));
    this.light.position.set(-1500, 2600, 1800);
    this.light.castShadow = true;
    this.light.shadow.mapSize.set(2048, 2048);
    this.light.shadow.bias = -0.0002;
    this.light.shadow.normalBias = 1;
    this.light.shadow.radius = 3;
    this.scene.add(this.light, this.content, this.particles);
  }

  resize(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.renderer.setSize(this.width, this.height);
    this.setViewport(this.viewport);
  }

  setViewport(viewport: { x: number; y: number; zoom: number }): void {
    this.viewport = viewport;
    this.camera.left = -viewport.x / viewport.zoom;
    this.camera.right = (this.width - viewport.x) / viewport.zoom;
    this.camera.top = viewport.y / viewport.zoom;
    this.camera.bottom = (viewport.y - this.height) / viewport.zoom;
    this.camera.updateProjectionMatrix();
    this.draw();
  }

  orient(angle: CityAngle): void { orientCamera(this.camera, angle); this.draw(); }

  build(layout: Layout, origin: Point): void {
    const previous = this.layout;
    this.stopParticles();
    this.sweep = -1;
    for (const block of this.blocks.values()) utils.remove([block.group.scale, block.surface, block.outline]);
    disposeObject(this.content);
    this.content.clear();
    this.blocks.clear();
    this.tracks.clear();
    this.layout = layout;
    this.origin = origin;
    this.scene.background = this.color('ink-0');
    const extent = Math.max(layout.width, layout.height, 500) + 300;
    Object.assign(this.light.shadow.camera, { left: -extent, right: extent, top: extent, bottom: -extent, far: 7000 });
    this.light.shadow.camera.updateProjectionMatrix();

    const floor = new Mesh(new PlaneGeometry(layout.width + 100, layout.height + 100), new MeshBasicMaterial({ color: this.color('ink-0'), toneMapped: false }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(layout.width / 2 - origin.x, -0.5, layout.height / 2 - origin.y);
    floor.receiveShadow = true;
    this.content.add(floor);

    const gridPoints: Vector3[] = [];
    for (let x = 0; x <= layout.width; x += 80) gridPoints.push(this.world({ x, y: 0 }, 0), this.world({ x, y: layout.height }, 0));
    for (let y = 0; y <= layout.height; y += 80) gridPoints.push(this.world({ x: 0, y }, 0), this.world({ x: layout.width, y }, 0));
    this.content.add(new LineSegments(new BufferGeometry().setFromPoints(gridPoints), new LineBasicMaterial({ color: this.color('rule'), transparent: true, opacity: 0.35 })));
    layout.lanes.forEach((lane, index) => {
      if (index % 2) {
        const band = new Mesh(new PlaneGeometry(lane.x1 - lane.x0, layout.height), new MeshBasicMaterial({ color: this.color('ink-1'), toneMapped: false }));
        band.rotation.x = -Math.PI / 2;
        band.position.set((lane.x0 + lane.x1) / 2 - origin.x, -0.2, layout.height / 2 - origin.y);
        band.receiveShadow = true;
        this.content.add(band);
      }
    });
    const shadows = new Mesh(new PlaneGeometry(layout.width + 100, layout.height + 100), new ShadowMaterial({ opacity: 0.22, depthWrite: false }));
    shadows.rotation.x = -Math.PI / 2;
    shadows.position.set(layout.width / 2 - origin.x, 0.1, layout.height / 2 - origin.y);
    shadows.receiveShadow = true;
    this.content.add(shadows);

    for (const [id, placed] of layout.nodes) {
      const height = blockHeight(placed.node);
      const group = new Group();
      group.position.set(placed.x + NODE_W / 2 - origin.x, height / 2, placed.y + NODE_H / 2 - origin.y);
      group.userData.nodeId = id;
      const surface = new MeshStandardMaterial({ roughness: 0.85, metalness: 0, transparent: true });
      const geometry = new BoxGeometry(NODE_W, height, NODE_H);
      const mesh = new Mesh(geometry, surface);
      mesh.userData.nodeId = id;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      const outline = new LineBasicMaterial({ transparent: true });
      group.add(mesh, new LineSegments(new EdgesGeometry(geometry), outline));
      this.blocks.set(id, { group, surface, outline, nodeId: id });
      this.content.add(group);
      if (previous?.nodes.size && !previous.nodes.has(id) && !reducedMotion()) {
        group.scale.y = 0.55;
        animate(group.scale, { y: 1, duration: 360, ease: 'outQuart', onUpdate: this.drawWithShadows });
      }
    }
    for (const [id, edge] of layout.edges) {
      const points = edge.points.map((point) => this.world(point, 1));
      if (points.length < 2) continue;
      const role = dataRoleOf(edge.edge);
      const dashed = edge.edge.kinds.includes('HTTP_CALL') || role === 'transfer' || role === 'carry';
      const options = { color: this.color('dim'), transparent: true, opacity: 0.7 };
      const material = dashed ? new LineDashedMaterial({ ...options, dashSize: role === 'carry' ? 2 : 6, gapSize: 4 }) : new LineBasicMaterial(options);
      const line = new Line(new BufferGeometry().setFromPoints(points), material);
      line.computeLineDistances();
      this.content.add(line);
      let length = 0;
      for (let i = 1; i < points.length; i++) length += points[i]!.distanceTo(points[i - 1]!);
      this.tracks.set(id, { line, points, length, hot: false });
      // Arrowheads are actual floor geometry and obey block occlusion.
      const ends = [[points.at(-1)!, points.at(-2)!], ...(role === 'readwrite' ? [[points[0]!, points[1]!]] : [])];
      for (const [end, previous] of ends) {
        const direction = end!.clone().sub(previous!).normalize();
        const normal = new Vector3(-direction.z, 0, direction.x);
        const arrow = new Line(new BufferGeometry().setFromPoints([end!.clone().addScaledVector(direction, -7).addScaledVector(normal, 3.5), end!, end!.clone().addScaledVector(direction, -7).addScaledVector(normal, -3.5)]), material.clone());
        line.add(arrow);
      }
    }
    this.drawWithShadows();
  }

  emphasize(emphasis: CityEmphasis, selected: string | null, marks: Map<string, Mark>, flow: boolean, sweep: number, insight: { ids: Set<string>; color: string } | null = null): void {
    if (!this.layout) return;
    for (const [id, block] of this.blocks) {
      const node = this.layout.nodes.get(id)!.node;
      const category = isBroken(node) ? 'broken' : node.category === 'infra' ? 'utility' : node.category;
      const active = !emphasis.nodes || emphasis.nodes.has(id);
      const cited = !!insight?.ids.has(id);
      const categoryColor = this.color(category);
      block.surface.color.copy(this.color('ink-2')).lerp(categoryColor, id === selected ? 0.28 : 0.12);
      block.surface.opacity = active ? 1 : emphasis.soft ? 0.55 : 0.22;
      block.outline.color.copy(cited ? this.color(insight!.color) : marks.has(id) ? this.color(marks.get(id)!) : categoryColor);
      block.outline.opacity = active ? (id === selected || cited ? 1 : 0.6) : 0.16;
      block.group.children[0]!.castShadow = active;
      if (marks.get(id) === 'removed' && !reducedMotion()) {
        animate(block.surface, { opacity: 0, duration: 280, ease: 'inQuad', onUpdate: this.drawWithShadows });
        animate(block.outline, { opacity: 0, duration: 280, ease: 'inQuad' });
        animate(block.group.scale, { y: 0.01, duration: 280, ease: 'inQuad' });
      }
    }
    for (const [id, track] of this.tracks) {
      const edge = this.layout.edges.get(id)!.edge;
      track.hot = !!emphasis.edges?.has(id);
      const active = !emphasis.nodes || (emphasis.edges ? track.hot : emphasis.nodes.has(edge.source) && emphasis.nodes.has(edge.target));
      const role = dataRoleOf(edge);
      const color = this.color(track.hot ? 'text' : role === 'read' ? 'data' : role === 'write' || role === 'readwrite' ? 'service' : edge.kinds.includes('READS_FROM') || edge.kinds.includes('WRITES_TO') ? 'data' : 'dim');
      for (const child of [track.line, ...track.line.children] as Line[]) {
        const material = child.material as LineBasicMaterial;
        material.color.copy(color);
        material.opacity = active ? 0.85 : 0.12;
      }
    }
    if (this.sweep !== sweep || this.flow !== flow) {
      this.sweep = sweep;
      this.flow = flow;
      this.startParticles(flow);
    }
    this.drawWithShadows();
  }

  pick(clientX: number, clientY: number): string | null {
    const rect = this.host.getBoundingClientRect();
    this.raycaster.setFromCamera(new Vector2((clientX - rect.left) / rect.width * 2 - 1, -(clientY - rect.top) / rect.height * 2 + 1), this.camera);
    const meshes = [...this.blocks.values()].map((block) => block.group.children[0]!);
    return this.raycaster.intersectObjects(meshes, false)[0]?.object.userData.nodeId ?? null;
  }

  private world(point: Point, height: number): Vector3 { return new Vector3(point.x - this.origin.x, height, point.y - this.origin.y); }
  private draw = () => this.renderer.render(this.scene, this.camera);
  private drawWithShadows = () => { this.renderer.shadowMap.needsUpdate = true; this.draw(); };

  private startParticles(continuous: boolean): void {
    this.stopParticles();
    if (reducedMotion()) return;
    const tracks = [...this.tracks.values()].filter((track) => track.hot && track.length > 0).slice(0, 18);
    for (const track of tracks) {
      const dot = new Mesh(new SphereGeometry(2.8, 8, 6), new MeshStandardMaterial({ color: this.color('text'), emissive: this.color('text'), emissiveIntensity: 0.2 }));
      dot.userData.track = track;
      this.particles.add(dot);
    }
    if (!tracks.length) return;
    this.started = performance.now();
    const tick = (time: number) => {
      const elapsed = time - this.started;
      for (const dot of this.particles.children) {
        const track = dot.userData.track as Track;
        let remaining = (continuous ? (elapsed % 2400) / 2400 : Math.min(1, elapsed / 1300)) * track.length;
        for (let i = 1; i < track.points.length; i++) {
          const a = track.points[i - 1]!;
          const b = track.points[i]!;
          const length = a.distanceTo(b);
          if (remaining <= length || i === track.points.length - 1) { dot.position.copy(a).lerp(b, length ? Math.min(1, remaining / length) : 0); break; }
          remaining -= length;
        }
        dot.position.y += 3;
      }
      this.draw();
      if (continuous || elapsed < 1300) this.frame = requestAnimationFrame(tick);
      else { this.stopParticles(); this.draw(); }
    };
    this.frame = requestAnimationFrame(tick);
  }

  private stopParticles(): void { cancelAnimationFrame(this.frame); disposeObject(this.particles); this.particles.clear(); }
  refreshMotion(): void { this.startParticles(this.flow); this.draw(); }
  destroy(): void { this.stopParticles(); for (const block of this.blocks.values()) utils.remove([block.group.scale, block.surface, block.outline]); disposeObject(this.content); this.light.shadow.dispose(); this.renderer.dispose(); this.renderer.domElement.remove(); }
}
