/**
 * Harness CLI 的 Web 端入口：在输入框工具栏加一个「瞄准」图标，
 * 点击后像「权限」控件那样在按钮上方弹出菜单，选中后只填入输入框，按 Enter 才发起对应指令。
 *
 * 设计约束：
 * - 只用槽位标准 props（inputActions），不读别的插件的 DOM 与样式；
 * - 菜单用 portal 挂到 document.body：输入框是 fixed 定位的容器，不 portal 会被裁掉；
 * - 颜色全部走 --dsw-alias-* 主题令牌，深浅色自动跟随；
 * - 所有注册都在 apply 里，卸载时由槽位与 styles 统一回收。
 */
_ModuleLoader__.load({
  id: 'dsh-plugin-harness-cli',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useRef, useState } = React;

    // react-dom 是页面基线依赖（宿主自己的控件也用它做 portal）
    let ReactDOM = null;
    try {
      ReactDOM = require('react-dom');
    } catch (err) {
      ReactDOM = null;
    }

    /** 指令清单：选中后统一填入输入框；needsArg 只决定末尾是否留一个空格。 */
    const COMMANDS = [
      {
        name: 'harness-cli init',
        label: '初始化',
        desc: '生成骨架（默认启用任务页能力）',
        needsArg: false,
      },
      {
        name: 'harness-cli check',
        label: '校验',
        desc: '只读校验配置与流程证据',
        needsArg: false,
      },
      {
        name: 'harness-cli doctor',
        label: '自检',
        desc: '检查工具与环境本身',
        needsArg: false,
      },
      {
        name: 'harness-cli page',
        label: '建任务',
        desc: '建任务页 + 四份规范文档 + 方案页',
        needsArg: true,
      },
      {
        name: 'harness-cli plan',
        label: '方案',
        desc: '补全方案并弹窗确认（确认可选）',
        needsArg: true,
      },
      {
        name: 'harness-cli review',
        label: '复盘',
        desc: '核对文档与页面，写 review.md',
        needsArg: true,
      },
      {
        name: 'harness-cli continue',
        label: '继续任务',
        desc: '选择未完成任务，从当前进度继续',
        needsArg: false,
      },
      {
        name: 'harness-cli restart',
        label: '重跑任务',
        desc: '多选任务：进度归零后从 Step 1 重跑',
        needsArg: false,
      },
      {
        name: 'harness-cli ux',
        label: 'UX 分析',
        desc: '多选任务或自定义需求，生成 UX 报告',
        needsArg: false,
      },
      {
        name: 'harness-cli ui',
        label: 'UI 设计',
        desc: '生成 antd 风格设计稿',
        needsArg: true,
      },
      {
        name: 'harness-cli sql',
        label: '数据库设计',
        desc: '多选任务：按 Google 数模规范生成 schema 与 ER 图',
        needsArg: false,
      },
      {
        name: 'harness-cli delete',
        label: '删除任务',
        desc: '多选任务：删除任务与数据，进行中先停止',
        needsArg: false,
      },
      {
        name: 'harness-cli wiki',
        label: '业务 wiki',
        desc: '生成 / 更新 docs/wiki',
        needsArg: false,
      },
      {
        name: 'harness-cli plans',
        label: '任务总览',
        desc: '生成 plans.html 操作台',
        needsArg: false,
      },
      {
        name: 'harness-cli agents',
        label: '入口地图',
        desc: '由配置重新生成 AGENTS.md',
        needsArg: false,
      },
      {
        name: 'harness-cli help',
        label: '帮助',
        desc: '查看全部工具与指令用法',
        needsArg: false,
      },
    ];

    const MENU_WIDTH = 300;

    /** 上下键在菜单项之间循环；Home / End 跳到首尾。 */
    function menuIndexForKey(currentIndex, key, count) {
      if (count <= 0) return -1;
      if (key === 'ArrowDown')
        return currentIndex < 0 ? 0 : (currentIndex + 1) % count;
      if (key === 'ArrowUp')
        return currentIndex < 0
          ? count - 1
          : (currentIndex - 1 + count) % count;
      if (key === 'Home') return 0;
      if (key === 'End') return count - 1;
      return currentIndex;
    }

    const CSS = `
.hcli-cmd-btn{display:inline-flex;align-items:center;gap:5px;height:30px;padding:0 8px;
  border:1px solid transparent;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);
  cursor:pointer;font:inherit;font-size:12.5px;line-height:1;transition:background .15s,color .15s}
.hcli-cmd-btn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.hcli-cmd-btn.is-open{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-brand-primary)}
.hcli-cmd-menu{position:fixed;z-index:9999;box-sizing:border-box;background:var(--dsw-alias-bg-overlay);
  border:1px solid var(--dsw-alias-border-l1);border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.18);
  padding:6px;overflow-y:auto;font:13px/1.45 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
  color:var(--dsw-alias-label-primary)}
.hcli-cmd-menu-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;
  padding:2px 8px 6px;color:var(--dsw-alias-label-secondary);font-size:11.5px}
.hcli-cmd-menu-head b{color:var(--dsw-alias-label-primary);font-size:12.5px;font-weight:600}
.hcli-cmd-item{display:flex;align-items:baseline;justify-content:space-between;gap:10px;width:100%;
  padding:7px 8px;border:0;border-radius:6px;background:transparent;color:inherit;text-align:left;
  cursor:pointer;font:inherit}
.hcli-cmd-item:hover,.hcli-cmd-item:focus-visible{background:var(--dsw-alias-bg-layer-2);outline:none}
.hcli-cmd-item span{font-weight:500}
.hcli-cmd-item em{font-style:normal;color:var(--dsw-alias-label-secondary);font-size:11.5px;
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.hcli-cmd-sep{height:1px;margin:5px 6px;background:var(--dsw-alias-border-l1)}
`;

    /**
     * 把一条指令写进输入框。
     * 与 / 菜单一致：只填入草稿，不自动 submit；由用户确认后按 Enter 发起，
     * 保证输入框的指令 chip 与 / 菜单走完全相同的解析路径。
     */
    function launch(command, inputActions) {
      if (!inputActions || typeof inputActions.setDraft !== 'function') return;
      const line = `/${command.name}${command.needsArg ? ' ' : ''}`;
      inputActions.setDraft(line);
      try {
        if (typeof inputActions.focus === 'function') inputActions.focus();
      } catch (err) {
        // 宿主没有 focus 也不影响：草稿已在输入框里
      }
    }

    function CrosshairIcon() {
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: 18,
          height: 18,
          'aria-hidden': true,
          focusable: 'false',
        },
        h('circle', {
          cx: 12,
          cy: 12,
          r: 6.5,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
        }),
        h('circle', { cx: 12, cy: 12, r: 1.6, fill: 'currentColor' }),
        h('path', {
          d: 'M12 1.5v4.2M12 18.3v4.2M1.5 12h4.2M18.3 12h4.2',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
        }),
      );
    }

    /**
     * DSH 宿主的两个占位文案是写死的：
     * - question / custom.placeholder = 输入你的答案（问题卡片的自定义输入）
     * - conversation / placeholder.default、placeholder.hero = 发消息或创建任务…
     * 插件没有公开的 locale override 入口；这里在 locale 服务上做一次最小包装，
     * 只改这两个 key，其余翻译原样交给宿主。服务被冻结时保持宿主文案。
     */
    function applyPlaceholderOverrides(ctx) {
      const locale =
        (ctx && ctx.locale) ||
        (ctx && typeof ctx.get === 'function' ? ctx.get('locale') : undefined);
      if (
        !locale ||
        typeof locale.translate !== 'function' ||
        locale.__harnessCliPlaceholders === true
      ) {
        return false;
      }
      const original = locale.translate.bind(locale);
      try {
        const patched = function (ns, key, params) {
          if (ns === 'question' && key === 'custom.placeholder')
            return '请输入';
          if (
            ns === 'conversation' &&
            (key === 'placeholder.default' || key === 'placeholder.hero')
          ) {
            return '请输入自定义语义';
          }
          return original(ns, key, params);
        };
        locale.translate = patched;
        if (locale.translate !== patched) return false;
        locale.__harnessCliPlaceholders = true;
        return true;
      } catch (err) {
        return false;
      }
    }

    return {
      inject: ['slots', 'locale'],
      menuIndexForKey,
      launch,
      applyPlaceholderOverrides,
      apply(ctx) {
        applyPlaceholderOverrides(ctx);
        function CommandButton(props) {
          const { inputActions } = props;
          const [open, setOpen] = useState(false);
          const [pos, setPos] = useState(null);
          const buttonRef = useRef(null);
          const menuRef = useRef(null);
          const itemRefs = useRef([]);

          const focusItem = useCallback((index) => {
            const item = itemRefs.current[index];
            if (item && typeof item.focus === 'function') item.focus();
          }, []);

          const moveFocus = useCallback(
            (key) => {
              const current = itemRefs.current.findIndex(
                (item) => item === document.activeElement,
              );
              const next = menuIndexForKey(current, key, COMMANDS.length);
              if (next >= 0) focusItem(next);
            },
            [focusItem],
          );

          const place = useCallback(() => {
            const el = buttonRef.current;
            if (!el || typeof window === 'undefined') return;
            const rect = el.getBoundingClientRect();
            const viewport = window.innerWidth || 1024;
            const maxLeft = Math.max(8, viewport - MENU_WIDTH - 8);
            setPos({
              left: Math.min(Math.max(8, rect.left), maxLeft),
              // 贴在按钮上方，像权限菜单一样朝上展开
              bottom: Math.max(8, window.innerHeight - rect.top + 8),
              width: MENU_WIDTH,
              maxHeight: Math.max(160, rect.top - 24),
            });
          }, []);

          useEffect(() => {
            if (!open) return undefined;
            place();
            const onReposition = () => place();
            const onPointerDown = (event) => {
              if (menuRef.current && menuRef.current.contains(event.target))
                return;
              if (buttonRef.current && buttonRef.current.contains(event.target))
                return;
              setOpen(false);
            };
            const onKeyDown = (event) => {
              if (event.key !== 'Escape') return;
              setOpen(false);
              if (buttonRef.current) buttonRef.current.focus();
            };
            window.addEventListener('resize', onReposition);
            window.addEventListener('scroll', onReposition, true);
            document.addEventListener('pointerdown', onPointerDown, true);
            document.addEventListener('keydown', onKeyDown, true);
            return () => {
              window.removeEventListener('resize', onReposition);
              window.removeEventListener('scroll', onReposition, true);
              document.removeEventListener('pointerdown', onPointerDown, true);
              document.removeEventListener('keydown', onKeyDown, true);
            };
          }, [open, place]);

          const choose = useCallback(
            (command) => {
              setOpen(false);
              launch(command, inputActions);
            },
            [inputActions],
          );

          const toggleMenu = () => {
            if (open) {
              setOpen(false);
              return;
            }
            setOpen(true);
            const raf =
              typeof requestAnimationFrame === 'function'
                ? requestAnimationFrame
                : (fn) => setTimeout(fn, 0);
            raf(() => focusItem(0));
          };

          const menu = h(
            'div',
            {
              className: 'hcli-cmd-menu',
              ref: menuRef,
              role: 'menu',
              'aria-label': 'Harness-CLI 指令',
              onKeyDown: (event) => {
                if (
                  !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)
                )
                  return;
                event.preventDefault();
                moveFocus(event.key);
              },
              style: pos
                ? {
                    left: pos.left,
                    bottom: pos.bottom,
                    width: pos.width,
                    maxHeight: pos.maxHeight,
                  }
                : { left: 8, bottom: 80, width: MENU_WIDTH },
            },
            h(
              'div',
              { className: 'hcli-cmd-menu-head' },
              h('b', null, 'Harness-CLI 指令'),
              h('span', null, 'Esc 关闭'),
            ),
            h('div', { className: 'hcli-cmd-sep' }),
            COMMANDS.map((command, index) =>
              h(
                'button',
                {
                  key: command.name,
                  ref: (node) => {
                    itemRefs.current[index] = node;
                  },
                  type: 'button',
                  role: 'menuitem',
                  tabIndex: -1,
                  className: 'hcli-cmd-item',
                  title: command.desc,
                  onClick: () => choose(command),
                },
                h('span', null, command.label),
                h('em', null, `/${command.name}`),
              ),
            ),
          );

          return h(
            React.Fragment,
            null,
            h(
              'button',
              {
                ref: buttonRef,
                type: 'button',
                className: `hcli-cmd-btn${open ? ' is-open' : ''}`,
                title: 'Harness-CLI 指令',
                'aria-label': 'Harness-CLI 指令',
                'aria-haspopup': 'menu',
                'aria-expanded': open ? 'true' : 'false',
                onClick: toggleMenu,
                onKeyDown: (event) => {
                  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')
                    return;
                  event.preventDefault();
                  setOpen(true);
                  const raf =
                    typeof requestAnimationFrame === 'function'
                      ? requestAnimationFrame
                      : (fn) => setTimeout(fn, 0);
                  const next = menuIndexForKey(-1, event.key, COMMANDS.length);
                  raf(() => focusItem(next));
                },
              },
              h(CrosshairIcon, null),
              h('span', { style: { whiteSpace: 'nowrap' } }, '指令'),
            ),
            open && typeof document !== 'undefined'
              ? ReactDOM && typeof ReactDOM.createPortal === 'function'
                ? ReactDOM.createPortal(menu, document.body)
                : menu
              : null,
          );
        }

        if (
          typeof styles !== 'undefined' &&
          styles &&
          typeof styles.insert === 'function'
        ) {
          ctx.effect(
            () => styles.insert(CSS),
            'harness-cli command menu styles',
          );
        }

        ctx.slots.inject('conversation.input.left', () =>
          ctx.slots.register(
            {
              name: 'conversation.input.left',
              id: 'harness-cli-commands',
              order: 60,
              label: 'Harness-CLI 指令',
            },
            CommandButton,
          ),
        );
      },
    };
  },
});
