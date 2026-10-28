import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PIPELINE_DIR = fileURLToPath(new URL('../assets/resource/pipeline', import.meta.url));

type Node = Record<string, unknown>;

interface Graph {
  readonly nodes: Record<string, Node>;
  readonly files: string[];
}

function loadGraph(): Graph {
  const nodes: Record<string, Node> = {};
  const files = readdirSync(PIPELINE_DIR).filter((name) => name.endsWith('.json'));
  for (const file of files) {
    const parsed = JSON.parse(readFileSync(join(PIPELINE_DIR, file), 'utf8')) as Record<string, Node>;
    for (const [name, node] of Object.entries(parsed)) {
      if (nodes[name]) throw new Error(`节点名重复：${name}（${file}）`);
      nodes[name] = node;
    }
  }
  return { nodes, files };
}

const graph = loadGraph();

/** MAA 的 tasks 字段出现在这里，说明误把 MAA 资源当成了 MaaFramework pipeline。 */
const FORBIDDEN = ['algorithm', 'text', 'baseTask', 'sub', 'maxTimes', 'exceededNext', 'specificRect', 'rectMove'];

describe('pipeline JSON', () => {
  it('六个文件都存在且至少有一个节点', () => {
    expect(graph.files.sort()).toEqual([
      'nav_chip.json',
      'nav_common.json',
      'nav_main.json',
      'nav_resource.json',
      'nav_roguelike_entry.json',
      'nav_side.json',
    ]);
    expect(Object.keys(graph.nodes).length).toBeGreaterThan(20);
  });

  it('每个节点都有 recognition 与 action，且不混入 MAA 字段', () => {
    for (const [name, node] of Object.entries(graph.nodes)) {
      expect(node.recognition, name).toBeTypeOf('string');
      expect(node.action, name).toBeTypeOf('string');
      for (const key of FORBIDDEN) {
        expect(node, `${name} 不应包含 ${key}`).not.toHaveProperty(key);
      }
    }
  });

  it('next 与 on_error 指向的节点都存在', () => {
    for (const [name, node] of Object.entries(graph.nodes)) {
      for (const key of ['next', 'on_error'] as const) {
        const list = node[key];
        if (list === undefined) continue;
        expect(Array.isArray(list), `${name}.${key} 必须是数组`).toBe(true);
        for (const target of list as unknown[]) {
          expect(typeof target, `${name}.${key}`).toBe('string');
          expect(graph.nodes, `${name}.${key} → ${String(target)}`).toHaveProperty(String(target));
        }
      }
    }
  });

  it('六个入口节点都在', () => {
    for (const entry of [
      'NavCommon@Ping',
      'NavResource@Begin',
      'NavChip@Begin',
      'NavMain@Begin',
      'NavSide@Begin',
      'NavRoguelike@Begin',
    ]) {
      expect(graph.nodes, entry).toHaveProperty(entry);
    }
  });

  it('OCR 节点都带 expected 与四元 ROI', () => {
    for (const [name, node] of Object.entries(graph.nodes)) {
      if (node.recognition !== 'OCR') continue;
      expect(node.expected, name).toBeDefined();
      expect(Array.isArray(node.roi) && (node.roi as unknown[]).length === 4, `${name}.roi`).toBe(true);
    }
  });

  it('动态节点仍保留哨兵，交给 override 替换', () => {
    const sentinels: Array<[string, string]> = [
      ['NavResource@FindStage', '__STAGE__'],
      ['NavMain@FindStage', '__STAGE__'],
      ['NavMain@Chapter', '__CHAPTER__'],
      ['NavSide@FindActivity', '__ACTIVITY__'],
      ['NavSide@FindStage', '__STAGE__'],
      ['NavRoguelike@FindTheme', '__THEME__'],
    ];
    for (const [name, sentinel] of sentinels) {
      expect(JSON.stringify(graph.nodes[name]), name).toContain(sentinel);
    }
  });
});
