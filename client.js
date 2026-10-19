/**
 * Client 半身入口：包在 DeepSeek Harness 的模块加载器壳里，factory 返回 Cordis 插件对象。
 *
 * 快捷键动作注册、以及它与 Host 命令的接线，由「Task: 快捷键与设置入口（Client 半身）」补齐。
 */

window.__ModuleLoader__.load({
  id: 'dsh-retry',
  factory() {
    return {
      inject: [],
      apply() {},
    };
  },
});
