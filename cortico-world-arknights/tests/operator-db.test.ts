import { describe, expect, it, beforeEach } from 'vitest';
import { OperatorDatabase } from '../src/battle/operator-db.ts';

describe('OperatorDatabase 干员属性静态数据库', () => {
  beforeEach(() => {
    OperatorDatabase.resetInstance();
  });

  it('能成功从 MAA resource 载入干员数据并识别核心干员', () => {
    const db = OperatorDatabase.getInstance('D:/soft/MAA-v6/resource');
    expect(db.size).toBeGreaterThan(100);

    // 验证乌尔比安：近卫 (地面)
    const ulpian = db.getOperator('乌尔比安');
    expect(ulpian).not.toBeNull();
    expect(ulpian?.profession).toBe('近卫');
    expect(ulpian?.position).toBe('MELEE');
    expect(ulpian?.positionZh).toBe('地面');
    expect(ulpian?.rarity).toBe(6);

    // 验证娜仁图亚：狙击 (高台)
    const narentuya = db.getOperator('娜仁图亚');
    expect(narentuya).not.toBeNull();
    expect(narentuya?.profession).toBe('狙击');
    expect(narentuya?.position).toBe('RANGED');
    expect(narentuya?.positionZh).toBe('高台');
    expect(narentuya?.rarity).toBe(6);

    // 验证怒潮凛冬：近卫 (地面，异格)
    const winterAlter = db.getOperator('怒潮凛冬');
    expect(winterAlter).not.toBeNull();
    expect(winterAlter?.profession).toBe('近卫');
    expect(winterAlter?.position).toBe('MELEE');

    // 验证原版凛冬：先锋 (地面)
    const winter = db.getOperator('凛冬');
    expect(winter).not.toBeNull();
    expect(winter?.profession).toBe('先锋');
    expect(winter?.position).toBe('MELEE');

    // 验证德克萨斯：先锋 (地面)
    const texas = db.getOperator('德克萨斯');
    expect(texas).not.toBeNull();
    expect(texas?.profession).toBe('先锋');
    expect(texas?.position).toBe('MELEE');

    // 验证凯尔希：医疗 (高台)
    const kalts = db.getOperator('凯尔希');
    expect(kalts).not.toBeNull();
    expect(kalts?.profession).toBe('医疗');
    expect(kalts?.position).toBe('RANGED');
  });

  it('能精准区分原版与异格干员的职业与站位', () => {
    const db = OperatorDatabase.getInstance('D:/soft/MAA-v6/resource');
    // 原版安洁莉娜：辅助、高台
    const angelina = db.getOperator('安洁莉娜');
    expect(angelina).not.toBeNull();
    expect(angelina?.profession).toBe('辅助');
    expect(angelina?.position).toBe('RANGED');

    // 异格予愿安洁莉娜：特种、地面
    const angelinaAlter = db.getOperator('予愿安洁莉娜');
    expect(angelinaAlter).not.toBeNull();
    expect(angelinaAlter?.profession).toBe('特种');
    expect(angelinaAlter?.position).toBe('MELEE');
  });
});
