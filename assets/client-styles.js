/* ── 限流中断后「解禁再继续」（本补丁新增）─────────────────────────────
   ⚠️ 这一整段是插进上面那个 STYLES 模板字符串**内部**的，故：
   ① 不能用反引号（会提前闭合模板）；
   ② 不能用美元花括号插值（会被当成模板插值）;
   ③ 追加后紧跟着模板的收尾反引号，**不要**在这段里自带收尾。
   颜色全部走宿主 token（跟随主题），不写死色值。 */

/* 行尾格子：turnErrorRow 是 grid-template-columns: 10px minmax(0,1fr) auto，
   新格子落进 auto 轨道 ⇒ 紧跟错误码。align-self:center 让它与单行文案对齐，
   而不是被拉伸到两行高的文案块顶端。 */
.dim-jh-resumeSlot { align-self: center; display: inline-flex; }

.dim-jh-resumeToggle { display: inline-flex; align-items: center; gap: 5px; margin: 0; padding: 2px 8px;
  border: 1px solid var(--dsw-alias-border-l2, #dfe1e5); border-radius: 8px; background: none;
  font: inherit; font-size: 11px; line-height: 16px; cursor: pointer;
  color: var(--dsw-alias-state-warn-primary, #d98b00); transition: border-color .15s ease, background .15s ease, color .15s ease; }

.dim-jh-resumeToggle:hover:not(:disabled) { border-color: currentColor;
  background: color-mix(in srgb, currentColor 8%, transparent); }
.dim-jh-resumeToggle:disabled { opacity: 0.55; cursor: default; }
.dim-jh-resumeToggle:focus-visible { outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, currentColor 30%, transparent); }

/* 「不自动继续」这一态：红色叉 + 红色描边（同一套 token，别换色系）。 */
.dim-jh-resumeToggleOff { color: var(--dsw-alias-state-error-primary, #d93025); }

.dim-jh-resumeIcon { flex: none; display: block; }
.dim-jh-resumeText { white-space: nowrap; }
