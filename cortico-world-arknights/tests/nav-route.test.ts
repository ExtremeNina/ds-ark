import { describe, expect, it } from 'vitest';
import { roguelikeRoute, routeFor } from '../src/nav/route.ts';

function overridesOf(result: ReturnType<typeof routeFor>): Record<string, unknown> {
  if (!result.ok) throw new Error(result.error);
  return result.route.overrides;
}

describe('关卡路由', () => {
  it('资源本：5 级与 6 级用不同 ROI，只换 override 不换入口', () => {
    const five = routeFor('CE-5');
    const six = routeFor('CE-6');
    if (!five.ok || !six.ok) throw new Error('路由失败');
    expect(five.route.entry).toBe('NavResource@Begin');
    expect(six.route.entry).toBe('NavResource@Begin');
    expect(overridesOf(five)['NavResource@FindStage']).toMatchObject({ roi: [820, 120, 320, 260] });
    expect(overridesOf(six)['NavResource@FindStage']).toMatchObject({ roi: [900, 80, 340, 200] });
    expect(JSON.stringify(overridesOf(five))).toContain('CE');
  });

  it('芯片本：PR-A-1 与 PR-B-2 走不同 ROI 的芯片链路', () => {
    const one = routeFor('PR-A-1');
    const two = routeFor('PR-B-2');
    if (!one.ok || !two.ok) throw new Error('路由失败');
    expect(one.route.entry).toBe('NavChip@Begin');
    expect(two.route.entry).toBe('NavChip@Begin');
    expect(overridesOf(one)['NavChip@FindStage']).toMatchObject({ roi: [27, 260, 742, 400] });
    expect(overridesOf(two)['NavChip@FindStage']).toMatchObject({ roi: [472, 0, 793, 502] });
  });

  it('主线：代号前缀生成多关键词匹配列表，覆盖篇章名与卡片名', () => {
    const one = routeFor('1-7');
    if (!one.ok) throw new Error(one.error);
    expect(one.route.entry).toBe('NavMain@Begin');
    const oneExpected = (one.route.overrides['NavMain@Chapter'] as { expected: string[] }).expected;
    expect(oneExpected).toContain('觉醒');
    expect(oneExpected).toContain('黑暗时代');
    expect(JSON.stringify(one.route.overrides['NavMain@FindStage'])).toContain('1');

    const two = routeFor('2-10');
    if (!two.ok) throw new Error(two.error);
    expect(two.route.entry).toBe('NavMain@Begin');
    const twoExpected = (two.route.overrides['NavMain@Chapter'] as { expected: string[] }).expected;
    expect(twoExpected).toContain('异卵同生');
    expect(twoExpected).toContain('觉醒');
    expect(JSON.stringify(two.route.overrides['NavMain@FindStage'])).toContain('2');
  });

  it('SideStory：活动关键词、页签与 ROI 都进 override', () => {
    const result = routeFor('AD-8');
    if (!result.ok) throw new Error(result.error);
    expect(result.route.entry).toBe('NavSide@Begin');
    expect(result.route.overrides['NavSide@EnterTab']).toMatchObject({ expected: '别传' });
    expect(JSON.stringify(result.route.overrides['NavSide@FindActivity'])).toContain('红丝绒');
    expect(result.route.overrides['NavSide@Start']).toMatchObject({ roi: [900, 360, 380, 260] });
  });

  it('未收录的活动与不认识的代号都返回可读错误', () => {
    const side = routeFor('ZZ-9');
    expect(side.ok).toBe(false);
    if (!side.ok) expect(side.error).toContain('还没支持这个活动关卡');

    const unknown = routeFor('???');
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error).toContain('不认识的关卡代号');
  });

  it('navMaxScrolls 会覆盖对应滚动节点', () => {
    const result = routeFor('LS-5', { maxScrolls: 3 });
    if (!result.ok) throw new Error(result.error);
    expect(result.route.overrides['NavResource@Scroll']).toMatchObject({ max_hit: 3 });
  });
});

describe('集成战略路由', () => {
  it('主题关键词进 override，并停在主题页', () => {
    const result = roguelikeRoute('傀影');
    if (!result.ok) throw new Error(result.error);
    expect(result.route.entry).toBe('NavRoguelike@Begin');
    expect(result.route.stopAt).toBe('theme');
    expect(JSON.stringify(result.route.overrides['NavRoguelike@FindTheme'])).toContain('傀影');
  });

  it('不认识的主题返回可读错误', () => {
    const result = roguelikeRoute('不存在');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('不认识这个集成战略主题');
  });
});
