/** 包入口：默认导出 `WorldDefinition`，加载器按 `cortico.kind === 'world'` 认它。 */
import { ARKNIGHTS } from './definition.ts';

export default ARKNIGHTS;
export { ARKNIGHTS };
export type { ArknightsConfigSection } from './config.ts';
