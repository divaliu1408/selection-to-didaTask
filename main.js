"use strict";
const obsidian = require("obsidian");

// ---------- helpers ----------
function cleanTitle(raw) {
  if (!raw) return "";
  const s = String(raw)
    .replace(/[《》〈〉「」『』【】〔〕]/g, "") // 去掉书名号/括号类装饰符号
    .replace(/[\u201C\u201D\u2018\u2019]/g, "") // 去掉中文弯引号
    .replace(/\s+/g, " ")
    .trim();
  return s || String(raw).trim();
}

function truncate(s, n) {
  if (!s) return "";
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function isNodeInsideSelection(sel, node) {
  try {
    if (sel && typeof sel.containsNode === "function") {
      let cur = node;
      while (cur && cur !== document.body && cur !== document.documentElement) {
        if (sel.containsNode(cur, true)) return true;
        cur = cur.parentElement || cur.parentNode;
      }
    }
  } catch (e) {}
  return false;
}

// ---------- 清单选择器（代替不可用的级联子菜单） ----------
class DidaProjectSuggestModal extends obsidian.FuzzySuggestModal {
  constructor(app, title, projects, onPick) {
    super(app);
    this.pickTitle = title;
    this.projects = projects || [];
    this.onPick = onPick;
    this.setPlaceholder("选择要添加到的滴答清单…");
    this.setInstructions([{ command: "↑↓", purpose: "选择" }, { command: "↵", purpose: "确认添加" }]);
  }
  getItems() {
    return this.projects;
  }
  getItemText(p) {
    return p && p.name ? p.name : "";
  }
  onChooseItem(p, evt) {
    if (p && this.onPick) this.onPick(p);
  }
}

// ---------- 添加理由输入框 ----------
class DidaReasonModal extends obsidian.Modal {
  /**
   * @param app Obsidian App
   * @param title 任务标题（已清理）
   * @param projectName 目标清单名
   * @param sourceNote 来源备注（自动附带）
   * @param selectionText 右键那一刻笔记中选中的原文（可为空）
   * @param onConfirm(reason) 用户填的理由（可能为空串）
   */
  constructor(app, title, projectName, sourceNote, selectionText, onConfirm) {
    super(app);
    this.pickTitle = title;
    this.projectName = projectName || "";
    this.sourceNote = sourceNote || "";
    this.selectionText = selectionText || "";
    this.onConfirm = onConfirm;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("dida-reason-modal");

    contentEl.createEl("h3", {
      text: `添加任务：「${this.pickTitle}」`,
    });

    const meta = contentEl.createDiv("dida-reason-meta");
    meta.createSpan({ text: `清单：${this.projectName}` });
    if (this.sourceNote) {
      meta.createDiv({ text: this.sourceNote, cls: "dida-reason-source" });
    }

    const label = contentEl.createEl("label", {
      text: "添加理由 / 备注（可选）：",
      cls: "dida-reason-label",
    });

    // 提示：可粘贴已复制的笔记文字
    const hint = contentEl.createDiv("dida-reason-hint");
    hint.setText("提示：可先在笔记里 Ctrl+C 复制文字，再在此框 Ctrl+V 粘贴。");
    hint.style.fontSize = "12px";
    hint.style.color = "var(--text-muted)";
    hint.style.margin = "2px 0 4px 0";

    const ta = new obsidian.TextAreaComponent(contentEl);
    ta.setPlaceholder("为什么把它加入任务？下次打开就能想起来。");
    ta.inputEl.addClass("dida-reason-input");
    ta.inputEl.style.width = "100%";
    ta.inputEl.style.minHeight = "90px";
    ta.inputEl.style.margin = "6px 0 10px 0";

    // 快捷按钮：插入右键那一刻选中的笔记文字
    if (this.selectionText) {
      const insertRow = contentEl.createDiv("dida-reason-insert-row");
      insertRow.style.display = "flex";
      insertRow.style.alignItems = "center";
      insertRow.style.gap = "8px";
      insertRow.style.marginBottom = "6px";
      new obsidian.ButtonComponent(insertRow)
        .setButtonText("插入笔记选中文字")
        .setType("button")
        .onClick(() => {
          const cur = ta.getValue() || "";
          const sep = cur && !cur.endsWith("\n") ? "\n" : "";
          const quote = `> ${this.selectionText.split("\n").join("\n> ")}`;
          ta.setValue(cur + sep + quote + "\n");
          ta.inputEl.focus();
        });
    }

    const btnRow = contentEl.createDiv("dida-reason-actions");
    btnRow.style.display = "flex";
    btnRow.style.justifyContent = "flex-end";
    btnRow.style.gap = "8px";

    const cancelBtn = new obsidian.ButtonComponent(btnRow)
      .setButtonText("取消")
      .setWarning()
      .onClick(() => this.close());

    const okBtn = new obsidian.ButtonComponent(btnRow)
      .setButtonText("添加任务")
      .setCta()
      .onClick(() => {
        const reason = ta.getValue() ? ta.getValue().trim() : "";
        if (this.onConfirm) this.onConfirm(reason);
        this.close();
      });

    // Enter 直接确认，Shift+Enter 换行
    ta.inputEl.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter" && !evt.shiftKey) {
        evt.preventDefault();
        okBtn.buttonEl.click();
      }
    });

    ta.inputEl.focus();
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

// ---------- plugin ----------
class SelectionToDida extends obsidian.Plugin {
  async onload() {
    new obsidian.Notice("Selection to Dida 已加载", 3000);
    // 编辑模式：官方 editor-menu 事件
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor, view) => {
        try {
          const raw = (editor.getSelection && editor.getSelection()) || "";
          const title = cleanTitle(raw);
          if (!title) return; // 无选区不添加
          this.populateMenu(menu, title, view, raw);
        } catch (e) {
          console.error("[selection-to-dida] editor-menu error", e);
          new obsidian.Notice(
            "Selection to Dida 出错：" + ((e && e.message) || String(e)),
            6000
          );
        }
      })
    );
    // 阅读模式：Obsidian 不给第三方插件阅读视图右键事件，
    // 用全局 contextmenu 兜底，注册在捕获阶段先于 Obsidian 自己的处理
    this.registerDomEvent(
      document,
      "contextmenu",
      (evt) => {
        this.handleGlobalContextMenu(evt);
      },
      true
    );
  }

  handleGlobalContextMenu(evt) {
    try {
      const target = evt && evt.target;
      if (!target) return;
      const el = target instanceof Element ? target : target.parentElement;
      if (!el) return;
      // 只处理 Markdown 阅读视图内的文本；链接/其他区域交给 Obsidian 原生菜单
      if (!el.closest(".markdown-preview-view")) return;
      if (el.closest("a, .internal-link, .cm-editor")) return;

      const sel = window.getSelection && window.getSelection();
      const raw = sel && sel.toString ? sel.toString() : "";
      const title = cleanTitle(raw);
      if (!title) return;
      // 右键点必须落在选区内（向上找祖先，命中即接管）
      if (!isNodeInsideSelection(sel, el)) return;

      evt.preventDefault();
      evt.stopPropagation();

      const view = this.app.workspace.getActiveViewOfType(obsidian.MarkdownView);
      const menu = new obsidian.Menu();
      this.populateMenu(menu, title, view, raw);
      menu.showAtMouseEvent(evt);
    } catch (e) {
      // 兜底失败不阻塞 Obsidian 原生右键
    }
  }

  // 往一个已打开的菜单里填充我们的项目
  // selectionText = 右键那一刻编辑器里的原文选区（标题的清理前原文）
  populateMenu(menu, title, view, selectionText) {
    const dida = this.getDidaPlugin();
    const label = `添加任务「${truncate(title, 16)}」`;
    if (!dida || !dida.settings || !dida.settings.accessToken) {
      menu.addItem((item) =>
        item
          .setTitle("添加到滴答任务（未登录）")
          .setIcon("list-plus")
          .onClick(() =>
            new obsidian.Notice("DidaSync 未启用或未登录，无法添加任务", 4000)
          )
      );
      return;
    }

    const showArchived = dida.settings.showArchivedProjects === true;
    let projects = [];
    try {
      if (typeof dida.getAvailableProjectConfigs === "function") {
        projects = dida.getAvailableProjectConfigs();
      }
    } catch (e) {}
    projects = (Array.isArray(projects) ? projects : []).filter(
      (p) => p && p.name && (showArchived || !p.isArchived)
    );

    let sourceNote = "";
    try {
      const file = view && view.file;
      if (file && file.path) {
        sourceNote = `来源：[[${file.path.replace(/\.md$/i, "")}]]`;
      }
    } catch (e) {}

    if (projects.length === 0) {
      menu.addItem((item) =>
        item
          .setTitle("添加到滴答任务（无可用清单）")
          .setIcon("list-plus")
          .onClick(() => new obsidian.Notice("没有可用的滴答清单", 4000))
      );
      return;
    }

    // 点击后弹出清单选择器（Obsidian Menu 无级联子菜单 API）
    menu.addItem((item) =>
      item
        .setTitle(label)
        .setIcon("list-plus")
        .onClick(() => {
          new DidaProjectSuggestModal(
            this.app,
            title,
            projects,
            (p) => {
              // 选中清单后，先让用户填写添加理由
              new DidaReasonModal(
                this.app,
                title,
                p.name,
                sourceNote,
                selectionText || "",
                (reason) =>
                  this.addTaskToProject(dida, title, sourceNote, reason, p)
              ).open();
            }
          ).open();
        })
    );
  }

  getDidaPlugin() {
    try {
      return this.app.plugins.plugins["didasync"] || null;
    } catch (e) {
      return null;
    }
  }

  async addTaskToProject(dida, title, sourceNote, reason, project) {
    try {
      const task = await dida.addTask(
        title,
        project.name,
        project.id,
        true, // shouldSync → 建到云端
        null,
        null
      );
      // 备注 = 来源 + 理由（各占一行），同步到云端
      const lines = [];
      if (sourceNote) lines.push(sourceNote);
      if (reason) lines.push(`理由：${reason}`);
      const noteText = lines.join("\n");
      if (task && noteText) {
        task.content = noteText;
        task.desc = noteText;
        try {
          await dida.saveSettings();
        } catch (e) {}
        try {
          if (typeof dida.syncTaskToDidaListInBackground === "function") {
            await dida.syncTaskToDidaListInBackground(task);
          }
        } catch (e) {
          // 本地已存，云端备注同步失败不致命
        }
      }
      new obsidian.Notice(
        `已添加到「${project.name}」：${truncate(title, 40)}`,
        4000
      );
    } catch (e) {
      new obsidian.Notice(
        "添加失败：" + ((e && e.message) || String(e)),
        6000
      );
    }
  }
}

module.exports = { __esModule: true, default: SelectionToDida };
