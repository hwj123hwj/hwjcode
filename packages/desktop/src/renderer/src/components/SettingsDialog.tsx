import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { Icon, type IconName } from './Icon';
import { useT, type TFunc } from '../i18n/useT';
import type { TranslationKey } from '../i18n/i18n';
import { useStore } from '../store';
import type {
  ComputerUseStatus,
  CustomModelEntry,
  CustomModelInput,
  CustomModelProvider,
  DesktopUserSettings,
  McpServerEntry,
  McpServerInput,
  McpTransport,
  ModelOverrides,
  ProjectMemoryMode,
  SessionKind,
  SessionMeta,
  ShellOption,
  TerminalShellKind,
  ThemeMode,
  VersionInfo,
} from '@shared/ipc';

const api = window.easycode;

const PROVIDERS: Array<{ id: CustomModelProvider; label: string }> = [
  { id: 'openai', label: 'OpenAI' },
  { id: 'openai-responses', label: 'OpenAI Responses' },
  { id: 'anthropic', label: 'Anthropic' },
  { id: 'gemini', label: 'Gemini' },
];

const EMPTY_FORM: CustomModelInput = {
  displayName: '',
  provider: 'openai',
  baseUrl: '',
  apiKey: '',
  modelId: '',
  maxTokens: undefined,
  enabled: true,
};

/** Project-memory modes — mirrors the CLI `/config` "项目记忆" submenu. */
const MEMORY_MODES: Array<{ id: ProjectMemoryMode; labelKey: TranslationKey; hintKey: TranslationKey }> = [
  { id: 'all', labelKey: 'settings.memoryAll', hintKey: 'settings.memoryAllHint' },
  { id: 'deepv-only', labelKey: 'settings.memoryDeepvOnly', hintKey: 'settings.memoryDeepvOnlyHint' },
  { id: 'none', labelKey: 'settings.memoryNone', hintKey: 'settings.memoryNoneHint' },
];

/**
 * Per-scene / per-sub-agent model overrides — mirrors the CLI `/config` "高级模型"
 * submenu. `autoKey` labels the cleared (empty) state: compression falls back to
 * the built-in default, sub-agents inherit the session model.
 */
const MODEL_OVERRIDE_FIELDS: Array<{
  key: keyof ModelOverrides;
  labelKey: TranslationKey;
  descKey: TranslationKey;
  autoKey: TranslationKey;
}> = [
  { key: 'compression', labelKey: 'settings.overrideCompression', descKey: 'settings.overrideCompressionDesc', autoKey: 'settings.overrideAutoDefault' },
  { key: 'codeExpert', labelKey: 'settings.overrideCodeExpert', descKey: 'settings.overrideCodeExpertDesc', autoKey: 'settings.overrideInherit' },
  { key: 'verification', labelKey: 'settings.overrideVerification', descKey: 'settings.overrideVerificationDesc', autoKey: 'settings.overrideInherit' },
];

/** GUI color-theme options shown as chips in the 外观 section. */
const THEME_MODES: Array<{ id: ThemeMode; labelKey: TranslationKey }> = [
  { id: 'system', labelKey: 'settings.themeSystem' },
  { id: 'light', labelKey: 'settings.themeLight' },
  { id: 'dark', labelKey: 'settings.themeDark' },
];

/** i18n label key for each integrated-terminal shell kind. */
const SHELL_LABEL: Record<TerminalShellKind, TranslationKey> = {
  default: 'settings.shellDefault',
  powershell: 'settings.shellPowershell',
  cmd: 'settings.shellCmd',
  gitbash: 'settings.shellGitbash',
  wsl: 'settings.shellWsl',
  bash: 'settings.shellBash',
  zsh: 'settings.shellZsh',
  fish: 'settings.shellFish',
};

/**
 * The id of every settings section. Add a new id here, give it an entry in
 * `GROUPS`, and write its `*Section` component — the left-nav rail and the
 * content area are both generated from `GROUPS`, so nothing else needs to change.
 */
export type SectionId =
  | 'general'
  | 'appearance'
  | 'personalization'
  | 'computerUse'
  | 'generalModel'
  | 'models'
  | 'mcp'
  | 'archivedChats'
  | 'about';

interface SectionDef {
  id: SectionId;
  icon: IconName;
  labelKey: TranslationKey;
  Component: () => ReactElement;
}

interface GroupDef {
  titleKey: TranslationKey;
  sections: SectionDef[];
}

/**
 * Declarative section registry — the single source of truth for the settings UI.
 * Each section reads/writes the shared `~/.easycode-user/…` stores the CLI uses,
 * so anything changed here is honoured by the CLI and by every newly created
 * session's `easycode --acp` backend:
 *   - 通用 / 外观 / 电脑控制 → `settings.json` (+ runtime computer-use toggle)
 *   - 自定义模型            → `custom-models.json`
 *
 * Grouped into categories (个人 / 集成 / …) so the rail scales as more settings
 * land without restructuring the layout.
 */
const GROUPS: GroupDef[] = [
  {
    titleKey: 'settings.groupPersonal',
    sections: [
      { id: 'general', icon: 'settings', labelKey: 'settings.tabGeneral', Component: GeneralSection },
      { id: 'appearance', icon: 'sparkle', labelKey: 'settings.navAppearance', Component: AppearanceSection },
      {
        id: 'personalization',
        icon: 'comment',
        labelKey: 'settings.navPersonalization',
        Component: PersonalizationSection,
      },
    ],
  },
  {
    titleKey: 'settings.groupIntegration',
    sections: [
      { id: 'computerUse', icon: 'laptop', labelKey: 'settings.navComputerUse', Component: ComputerUseSection },
      { id: 'generalModel', icon: 'switch', labelKey: 'settings.navGeneralModel', Component: GeneralModelSection },
      { id: 'models', icon: 'cpu', labelKey: 'settings.tabModels', Component: ModelsSection },
      { id: 'mcp', icon: 'wrench', labelKey: 'settings.navMcp', Component: McpSection },
    ],
  },
  {
    titleKey: 'settings.groupArchived',
    sections: [
      {
        id: 'archivedChats',
        icon: 'archive',
        labelKey: 'settings.navArchivedChats',
        Component: ArchivedChatsSection,
      },
    ],
  },
  {
    titleKey: 'settings.groupAbout',
    sections: [
      { id: 'about', icon: 'info', labelKey: 'settings.navAbout', Component: AboutSection },
    ],
  },
];

const ALL_SECTIONS = GROUPS.flatMap((g) => g.sections);

/**
 * Full-window settings surface (not a modal): a left rail of grouped, searchable
 * sections + a scrollable content pane on the right. The `initialTab` prop is the
 * id of the section to open first (kept for call-site compatibility — Login opens
 * straight on "models").
 */
export function SettingsDialog({
  onClose,
  initialTab = 'general',
}: {
  onClose: () => void;
  initialTab?: SectionId;
}) {
  const t = useT();
  const [active, setActive] = useState<SectionId>(initialTab);
  const [query, setQuery] = useState('');

  // Esc closes the surface, matching the back button.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const q = query.trim().toLowerCase();
  const groups = useMemo(() => {
    if (!q) return GROUPS;
    return GROUPS.map((g) => ({
      ...g,
      sections: g.sections.filter((s) => t(s.labelKey).toLowerCase().includes(q)),
    })).filter((g) => g.sections.length > 0);
  }, [q, t]);

  const section = ALL_SECTIONS.find((s) => s.id === active) ?? ALL_SECTIONS[0];
  const Active = section.Component;

  return (
    <div className="settings-surface">
      <nav className="settings-nav">
        <button className="settings-back" onClick={onClose}>
          <Icon name="arrow-left" size={15} />
          {t('settings.backToApp')}
        </button>

        <div className="settings-search">
          <Icon name="search" size={14} className="ic" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('settings.searchPlaceholder')}
          />
        </div>

        <div className="settings-nav-scroll">
          {groups.length === 0 && <div className="settings-nav-empty">{t('settings.searchNoMatch')}</div>}
          {groups.map((g) => (
            <div className="settings-nav-group" key={g.titleKey}>
              <div className="settings-nav-group-title">{t(g.titleKey)}</div>
              {g.sections.map((s) => (
                <button
                  key={s.id}
                  className={`settings-nav-item ${active === s.id ? 'active' : ''}`}
                  onClick={() => setActive(s.id)}
                >
                  <Icon name={s.icon} size={16} />
                  <span className="grow">{t(s.labelKey)}</span>
                </button>
              ))}
            </div>
          ))}
        </div>

        <div className="settings-nav-foot">
          {t('settings.subtitlePre')}
          <code>~/.easycode-user/</code>
          {t('settings.subtitlePost')}
        </div>
      </nav>

      <div className="settings-content" key={section.id}>
        <div className="settings-content-inner">
          <h2 className="settings-pane-title">{t(section.labelKey)}</h2>
          <Active />
        </div>
      </div>
    </div>
  );
}

/**
 * Small toast badge that fades in after a setting auto-saves. Lives in the
 * bottom-right of the content pane so it never shifts the layout.
 */
function SavedToast({ show }: { show: boolean }) {
  const t = useT();
  if (!show) return null;
  return (
    <div className="settings-saved">
      <Icon name="check" size={13} />
      {t('settings.saved')}
    </div>
  );
}

/**
 * Shared loader/writer for `~/.easycode-user/settings.json`. Every section that
 * mutates these settings goes through `patch`, which persists, refreshes local
 * state, and flashes the saved toast.
 */
function useUserSettings() {
  const [settings, setSettings] = useState<DesktopUserSettings | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void api.settings.get().then(setSettings);
  }, []);

  const patch = async (p: DesktopUserSettings) => {
    const next = await api.settings.update(p);
    setSettings(next);
    setSaved(true);
    setTimeout(() => setSaved(false), 1200);
    return next;
  };

  return { settings, setSettings, patch, saved };
}

/* ── 通用 ─────────────────────────────────────────────────────────────────
 * Display/reply language, project memory, healthy-use reminder, software update.
 * Model selection lives in its own 通用模型设置 section (GeneralModelSection).
 */
function GeneralSection() {
  const t = useT();
  const lang = useStore((s) => s.lang);
  const setLang = useStore((s) => s.setLang);
  const update = useStore((s) => s.update);
  const checkUpdate = useStore((s) => s.checkUpdate);
  const [checking, setChecking] = useState(false);
  const { settings, setSettings, patch, saved } = useUserSettings();
  const [replyLang, setReplyLang] = useState('');

  // Sync the reply-language input whenever settings (re)load.
  useEffect(() => {
    setReplyLang(settings?.preferredLanguage ?? '');
  }, [settings?.preferredLanguage]);

  const runCheck = async () => {
    setChecking(true);
    try {
      await checkUpdate(true);
    } finally {
      setChecking(false);
    }
  };

  // Resolve the line under the "Check for updates" button from the latest state.
  const curVersion = update?.currentVersion ?? __APP_VERSION__;
  const updateStatus = checking
    ? t('update.checking')
    : update?.phase === 'available' && update.info
      ? t('update.newAvailable', { version: update.info.version })
      : update?.phase === 'error'
        ? t('update.checkFailed')
        : t('update.upToDate', { version: curVersion });

  const commitLanguage = () => {
    if (replyLang.trim() === (settings?.preferredLanguage ?? '')) return;
    // Optimistic so the input doesn't flicker back while the write round-trips.
    setSettings((s) => (s ? { ...s, preferredLanguage: replyLang } : s));
    void patch({ preferredLanguage: replyLang });
  };

  const healthyEnabled = settings?.healthyUse === true; // undefined = off (default)
  const memoryMode: ProjectMemoryMode = settings?.projectMemoryMode ?? 'all';
  const memoryHint = MEMORY_MODES.find((m) => m.id === memoryMode)?.hintKey;

  return (
    <>
      <div className="setting-item">
        <label className="field-label">{t('settings.language')}</label>
        <div className="prompt-config">
          {(['zh', 'en'] as const).map((l) => (
            <span
              key={l}
              className={`chip interactive ${lang === l ? 'accent' : ''}`}
              onClick={() => setLang(l)}
            >
              {lang === l && <Icon name="check" size={13} />}
              {l === 'zh' ? t('settings.langZh') : t('settings.langEn')}
            </span>
          ))}
        </div>
      </div>

      <div className="setting-item">
        <label className="field-label">{t('settings.replyLanguage')}</label>
        <input
          className="prompt-input cm-input"
          placeholder={t('settings.replyLanguagePlaceholder')}
          value={replyLang}
          onChange={(e) => setReplyLang(e.target.value)}
          onBlur={commitLanguage}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
        />
        <div className="setting-desc">{t('settings.replyLanguageDesc')}</div>
      </div>

      <div className="setting-item">
        <label className="field-label">{t('settings.projectMemory')}</label>
        <div className="prompt-config">
          {MEMORY_MODES.map((m) => (
            <span
              key={m.id}
              className={`chip interactive ${memoryMode === m.id ? 'accent' : ''}`}
              title={t(m.hintKey)}
              onClick={() => void patch({ projectMemoryMode: m.id })}
            >
              {memoryMode === m.id && <Icon name="check" size={13} />}
              {t(m.labelKey)}
            </span>
          ))}
        </div>
        <div className="setting-desc">
          {t('settings.projectMemoryDesc', { hint: memoryHint ? t(memoryHint) : '' })}
        </div>
      </div>

      <div className="setting-item">
        <label className="setting-toggle">
          <input
            type="checkbox"
            checked={healthyEnabled}
            onChange={(e) => void patch({ healthyUse: e.target.checked })}
          />
          {t('settings.healthyUse')}
        </label>
        <div className="setting-desc">{t('settings.healthyUseDesc')}</div>
      </div>

      <div className="setting-item">
        <label className="field-label">{t('update.section')}</label>
        <div className="update-check-row">
          <button className="btn" disabled={checking} onClick={() => void runCheck()}>
            {checking ? <span className="spinner" /> : <Icon name="refresh" size={14} />}
            {t('update.checkNow')}
          </button>
          <span className="setting-desc">{updateStatus}</span>
        </div>
      </div>

      <SavedToast show={saved} />
    </>
  );
}

/* ── 通用模型设置 ───────────────────────────────────────────────────────────
 * Global default model + per-scene / per-sub-agent overrides (compression /
 * Code Expert / Verification). Carved out of 通用 into its own nav item; still
 * reads/writes the same `settings.json` keys (defaultModel / modelOverrides),
 * so the data binding is unchanged.
 */
function GeneralModelSection() {
  const t = useT();
  const order = useStore((s) => s.order);
  const sessions = useStore((s) => s.sessions);
  const { settings, patch, saved } = useUserSettings();
  const [modelOpts, setModelOpts] = useState<{ value: string; label: string }[]>([]);

  // Build the default-model options:
  //   1. Built-in models from ACP handshake (availableModels on any session),
  //      filtering out any stale `custom:` ids that may have been cached there.
  //   2. User's custom models, read fresh from disk on mount and whenever
  //      `customModelsRev` changes (save/delete in ModelsSection bumps it).
  // Decoupled from [order, sessions] so tab-switching doesn't re-fetch and
  // newly added models appear without requiring a session to already exist.
  const customModelsRev = useStore((s) => s.customModelsRev);
  useEffect(() => {
    let alive = true;
    const builtins = new Map<string, string>();
    for (const id of order) {
      for (const m of sessions[id]?.meta.availableModels ?? []) {
        // Skip stale custom-model ids that the backend cached in availableModels
        if (m.modelId.startsWith('custom:')) continue;
        if (!builtins.has(m.modelId)) builtins.set(m.modelId, m.name);
      }
    }
    const builtinOpts = [...builtins].map(([value, label]) => ({ value, label }));
    void api.models
      .listCustom()
      .then((custom) => {
        if (!alive) return;
        const seen = new Set<string>(builtinOpts.map((o) => o.value));
        const deduped = [
          ...builtinOpts,
          ...custom
            .filter((c) => c.enabled !== false)
            .map((c) => ({ value: c.id, label: c.label }))
            .filter(({ value }) => {
              if (seen.has(value)) return false;
              seen.add(value);
              return true;
            }),
        ];
        setModelOpts(deduped);
      })
      .catch(() => alive && setModelOpts(builtinOpts));
    return () => {
      alive = false;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customModelsRev]);

  return (
    <>
      <div className="setting-item">
        <label className="field-label">{t('settings.defaultModel')}</label>
        <ModelSelect
          value={settings?.defaultModel ?? ''}
          options={modelOpts}
          autoLabel={t('settings.defaultModelAuto')}
          onChange={(value) => void patch({ defaultModel: value })}
        />
        <div className="setting-desc">{t('settings.defaultModelDesc')}</div>
      </div>

      {/* 高级模型覆盖：压缩 / Code Expert / Verification 子代理。空值=恢复默认。 */}
      {MODEL_OVERRIDE_FIELDS.map((f) => (
        <div className="setting-item" key={f.key}>
          <label className="field-label">{t(f.labelKey)}</label>
          <ModelSelect
            value={settings?.modelOverrides?.[f.key] ?? ''}
            options={modelOpts}
            autoLabel={t(f.autoKey)}
            onChange={(value) =>
              void patch({
                modelOverrides: { ...(settings?.modelOverrides ?? {}), [f.key]: value },
              })
            }
          />
          <div className="setting-desc">{t(f.descKey)}</div>
        </div>
      ))}

      <SavedToast show={saved} />
    </>
  );
}

/* ── 外观 ─────────────────────────────────────────────────────────────────
 * GUI color theme (renderer-only preference) + integrated-terminal shell.
 */
function AppearanceSection() {
  const t = useT();
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  const { settings, patch, saved } = useUserSettings();
  const [shells, setShells] = useState<ShellOption[]>([]);

  useEffect(() => {
    void api.terminal.listShells().then(setShells).catch(() => undefined);
  }, []);

  // Options for the shell picker: always offer "default" first, then the
  // platform's shells (each flagged available/unavailable by the main process).
  const shellOptions: ShellOption[] = [{ id: 'default', available: true }, ...shells];
  const shellValue: TerminalShellKind = settings?.terminalShell ?? 'default';

  return (
    <>
      <div className="setting-item">
        <label className="field-label">{t('settings.theme')}</label>
        <div className="prompt-config">
          {THEME_MODES.map((m) => (
            <span
              key={m.id}
              className={`chip interactive ${theme === m.id ? 'accent' : ''}`}
              onClick={() => setTheme(m.id)}
            >
              {theme === m.id && <Icon name="check" size={13} />}
              {t(m.labelKey)}
            </span>
          ))}
        </div>
        <div className="setting-desc">{t('settings.themeDesc')}</div>
      </div>

      <div className="setting-item">
        <label className="field-label">{t('settings.terminalShell')}</label>
        <ShellSelect
          value={shellValue}
          options={shellOptions}
          onChange={(id) => void patch({ terminalShell: id })}
          t={t}
        />
        <div className="setting-desc">{t('settings.terminalShellDesc')}</div>
      </div>

      <SavedToast show={saved} />
    </>
  );
}

/* ── 个性化 ─────────────────────────────────────────────────────────────────
 * Global custom instructions, stored as `~/.easycode-user/DEEPV.md` (the user's
 * home-level memory the agent loads for every task on this machine — NOT a
 * project's `.easycode/DEEPV.md`). The CLI/backend read the same file on session
 * start, so a change here takes effect for newly created sessions / on restart.
 */
function PersonalizationSection() {
  const t = useT();
  const [content, setContent] = useState('');
  /** The last-saved content, so we can tell when there are unsaved edits. */
  const [saved, setSaved] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState(false);

  useEffect(() => {
    let alive = true;
    void api.settings
      .getInstructions()
      .then((text) => {
        if (!alive) return;
        setContent(text);
        setSaved(text);
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  const dirty = content !== saved;

  const save = async () => {
    setBusy(true);
    try {
      const persisted = await api.settings.saveInstructions(content);
      setContent(persisted);
      setSaved(persisted);
      setFlash(true);
      setTimeout(() => setFlash(false), 1200);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="setting-item">
      <label className="field-label">{t('settings.customInstructions')}</label>
      <div className="setting-desc">{t('settings.customInstructionsDesc')}</div>
      <textarea
        className="prompt-input instructions-area"
        placeholder={t('settings.customInstructionsPlaceholder')}
        value={content}
        disabled={loading}
        spellCheck={false}
        onChange={(e) => setContent(e.target.value)}
      />
      <div className="setting-note">{t('settings.customInstructionsHint')}</div>
      <div className="settings-pane-foot">
        <button className="btn primary" disabled={busy || loading || !dirty} onClick={save}>
          {busy ? <span className="spinner" /> : <Icon name="check" size={14} />}
          {t('common.save')}
        </button>
      </div>
      <SavedToast show={flash} />
    </div>
  );
}

/* ── 电脑控制 ──────────────────────────────────────────────────────────────
 * Runtime toggle for the desktop computer-use loop (not a settings.json field).
 */
function ComputerUseSection() {
  const t = useT();
  const [computerUse, setComputerUse] = useState<ComputerUseStatus | null>(null);
  // The preload tags <html> with the OS (see preload data-platform); used to show
  // macOS-only permission guidance for computer use.
  const isMac = document.documentElement.getAttribute('data-platform') === 'darwin';

  useEffect(() => {
    void api.computerUse.status().then(setComputerUse).catch(() => undefined);
    // Keep the toggle in sync if control starts/stops while the section is open.
    return api.computerUse.onStatus(setComputerUse);
  }, []);

  return (
    <div className="setting-item">
      <label className="setting-toggle">
        <input
          type="checkbox"
          checked={computerUse?.enabled === true}
          disabled={computerUse ? !computerUse.available : true}
          onChange={(e) => void api.computerUse.setEnabled(e.target.checked).then(setComputerUse)}
        />
        {t('settings.computerUse')}
      </label>
      <div className="setting-desc">
        {computerUse && !computerUse.available
          ? t('settings.computerUseUnavailable')
          : t('settings.computerUseDesc')}
      </div>
      {computerUse?.available && (
        <>
          <div className="setting-note setting-note-warn">{t('settings.computerUseExperimental')}</div>
          {isMac && <div className="setting-note">{t('settings.computerUseMacPerms')}</div>}
        </>
      )}
    </div>
  );
}

/* ── 关于 ─────────────────────────────────────────────────────────────────
 * VSCode-style version/environment readout: the desktop version, the bundled
 * backend version (easycode-cli-core), the Electron/Chromium/Node/V8 runtime,
 * and the OS. All values come from the main process via `app.getVersionInfo()`
 * (see main/appInfo.ts); the runtime names are proper nouns and not translated.
 */
function AboutSection() {
  const t = useT();
  const [info, setInfo] = useState<VersionInfo | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void api.app.getVersionInfo().then(setInfo).catch(() => undefined);
  }, []);

  const rows: Array<{ label: string; value: string }> = info
    ? [
        { label: t('settings.aboutDesktop'), value: info.desktop },
        { label: t('settings.aboutCliCore'), value: info.cliCore },
        { label: 'Electron', value: info.electron },
        { label: 'Chromium', value: info.chrome },
        { label: 'Node.js', value: info.node },
        { label: 'V8', value: info.v8 },
        { label: t('settings.aboutOs'), value: info.os },
      ]
    : [];

  const copy = async () => {
    if (!info) return;
    await api.clipboard.writeText(rows.map((r) => `${r.label}: ${r.value}`).join('\n'));
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className="setting-item">
      {!info ? (
        <div className="cm-empty">
          <span className="spinner" /> {t('common.loading')}
        </div>
      ) : (
        <>
          <div className="about-rows">
            {rows.map((r) => (
              <div className="about-row" key={r.label}>
                <span className="about-label">{r.label}</span>
                <span className="about-value">{r.value}</span>
              </div>
            ))}
          </div>
          <div className="settings-pane-foot">
            <button className="btn" onClick={() => void copy()}>
              <Icon name="copy" size={14} />
              {copied ? t('settings.aboutCopied') : t('settings.aboutCopy')}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Dropdown for the integrated-terminal shell. Shows the current selection with a
 * trailing check; unavailable shells (executable not found on this machine) are
 * listed but disabled, so the user understands why they can't pick them.
 */
function ShellSelect({
  value,
  options,
  onChange,
  t,
}: {
  value: TerminalShellKind;
  options: ShellOption[];
  onChange: (id: TerminalShellKind) => void;
  t: TFunc;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="shell-select" ref={ref}>
      <button className="shell-select-trigger" onClick={() => setOpen((o) => !o)}>
        <Icon name="terminal" size={14} />
        <span className="grow">{t(SHELL_LABEL[value])}</span>
        <Icon name="chevron-down" size={13} />
      </button>
      {open && (
        <div className="menu-pop" style={{ left: 0, top: '110%', minWidth: 240 }}>
          {options.map((o) => (
            <button
              key={o.id}
              disabled={!o.available}
              onClick={() => {
                if (!o.available) return;
                onChange(o.id);
                setOpen(false);
              }}
            >
              <span className="grow">{t(SHELL_LABEL[o.id])}</span>
              {!o.available && <span className="shell-na">{t('settings.shellUnavailable')}</span>}
              <Icon name="check" className={value === o.id ? 'shell-check' : 'placeholder'} size={14} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Dropdown for the global default model (Settings → 通用). Mirrors `ShellSelect`'s
 * look (`.shell-select` + `.menu-pop`) so the settings UI stays consistent. The
 * first entry is "Auto" (value ''); a saved-but-unlisted id still renders so the
 * current selection is never silently lost.
 */
function ModelSelect({
  value,
  options,
  autoLabel,
  onChange,
}: {
  value: string;
  options: { value: string; label: string }[];
  autoLabel: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Ensure a saved value that isn't in the (session-sourced) option list still
  // appears, so switching it later doesn't blank the trigger.
  const allOptions =
    value && !options.some((o) => o.value === value)
      ? [...options, { value, label: value }]
      : options;
  const currentLabel = value ? (allOptions.find((o) => o.value === value)?.label ?? value) : autoLabel;

  const choose = (v: string) => {
    onChange(v);
    setOpen(false);
  };

  return (
    <div className="shell-select" ref={ref}>
      <button className="shell-select-trigger" onClick={() => setOpen((o) => !o)}>
        <Icon name="cpu" size={14} />
        <span className="grow">{currentLabel}</span>
        <Icon name="chevron-down" size={13} />
      </button>
      {open && (
        <div className="menu-pop" style={{ left: 0, top: '110%', minWidth: 260, maxHeight: 320, overflowY: 'auto' }}>
          <button onClick={() => choose('')}>
            <span className="grow">{autoLabel}</span>
            <Icon name="check" className={!value ? 'shell-check' : 'placeholder'} size={14} />
          </button>
          {allOptions.map((o) => (
            <button key={o.value} onClick={() => choose(o.value)}>
              <span className="grow">{o.label}</span>
              <Icon name="check" className={value === o.value ? 'shell-check' : 'placeholder'} size={14} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── 自定义模型 ─────────────────────────────────────────────────────────────
 * Reads/writes the shared `~/.easycode-user/custom-models.json` (the same store
 * the CLI uses), so models added here are picked up by every newly created
 * session's ACP backend.
 */
function ModelsSection() {
  const t = useT();
  const [models, setModels] = useState<CustomModelEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<CustomModelInput | null>(null);
  /** displayName of the model being edited (undefined when adding). */
  const [editingName, setEditingName] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const refresh = async () => {
    setLoading(true);
    const list = await api.models.listCustom();
    setModels(list);
    setLoading(false);
  };

  useEffect(() => {
    void refresh();
  }, []);

  const startAdd = () => {
    setError('');
    setEditingName(undefined);
    setForm({ ...EMPTY_FORM });
  };

  const startEdit = (m: CustomModelEntry) => {
    setError('');
    setEditingName(m.displayName);
    setForm({
      displayName: m.displayName,
      provider: m.provider,
      baseUrl: m.baseUrl,
      apiKey: m.apiKey,
      modelId: m.modelId,
      maxTokens: m.maxTokens,
      enabled: m.enabled !== false,
    });
  };

  const remove = async (m: CustomModelEntry) => {
    await api.models.deleteCustom(m.displayName);
    useStore.getState().bumpCustomModelsRev();
    await refresh();
  };

  const save = async () => {
    if (!form) return;
    if (!form.displayName.trim()) return setError(t('settings.errName'));
    if (!form.baseUrl.trim()) return setError(t('settings.errBaseUrl'));
    if (!form.apiKey.trim()) return setError(t('settings.errApiKey'));
    if (!form.modelId.trim()) return setError(t('settings.errModelId'));
    setBusy(true);
    setError('');
    const res = await api.models.saveCustom(form, editingName);
    setBusy(false);
    if (!res.ok) {
      setError(res.error ?? t('settings.saveFailed'));
      return;
    }
    useStore.getState().bumpCustomModelsRev();
    setForm(null);
    setEditingName(undefined);
    await refresh();
  };

  const patch = (p: Partial<CustomModelInput>) => setForm((f) => (f ? { ...f, ...p } : f));

  return (
    <>
      {error && (
        <div className="login-err">
          <Icon name="alert" size={15} />
          {error}
        </div>
      )}

      {!form && (
        <>
          <div className="cm-list">
            {loading && (
              <div className="cm-empty">
                <span className="spinner" /> {t('common.loading')}
              </div>
            )}
            {!loading && models.length === 0 && <div className="cm-empty">{t('settings.noModels')}</div>}
            {models.map((m) => (
              <div className="cm-row" key={m.id}>
                <div className="cm-row-main">
                  <span className="cm-name">{m.displayName}</span>
                  <span className="cm-badge">
                    {PROVIDERS.find((p) => p.id === m.provider)?.label ?? m.provider}
                  </span>
                  {m.enabled === false && <span className="cm-badge muted">{t('settings.disabled')}</span>}
                </div>
                <div className="cm-row-sub">
                  {m.modelId} · {m.baseUrl}
                </div>
                <div className="cm-actions">
                  <button className="icon-btn" title={t('common.edit')} onClick={() => startEdit(m)}>
                    <Icon name="edit" size={14} />
                  </button>
                  <button className="icon-btn" title={t('common.delete')} onClick={() => void remove(m)}>
                    <Icon name="delete" size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
          <button className="btn" onClick={startAdd}>
            <Icon name="plus" size={14} />
            {t('settings.addModel')}
          </button>
        </>
      )}

      {form && (
        <>
          <div className="cm-form">
            <label className="field-label">{t('settings.name')}</label>
            <input
              className="prompt-input cm-input"
              placeholder={t('settings.namePlaceholder')}
              value={form.displayName}
              onChange={(e) => patch({ displayName: e.target.value })}
            />

            <label className="field-label">{t('settings.provider')}</label>
            <div className="prompt-config">
              {PROVIDERS.map((p) => (
                <span
                  key={p.id}
                  className={`chip interactive ${form.provider === p.id ? 'accent' : ''}`}
                  onClick={() => patch({ provider: p.id })}
                >
                  {form.provider === p.id && <Icon name="check" size={13} />}
                  {p.label}
                </span>
              ))}
            </div>

            <label className="field-label">Base URL</label>
            <input
              className="prompt-input cm-input"
              placeholder="https://api.openai.com/v1"
              value={form.baseUrl}
              onChange={(e) => patch({ baseUrl: e.target.value })}
            />

            <label className="field-label">API Key</label>
            <input
              className="prompt-input cm-input"
              type="password"
              placeholder={t('settings.apiKeyPlaceholder')}
              value={form.apiKey}
              onChange={(e) => patch({ apiKey: e.target.value })}
            />

            <label className="field-label">{t('settings.modelId')}</label>
            <input
              className="prompt-input cm-input"
              placeholder="gpt-4o / claude-3-5-sonnet / …"
              value={form.modelId}
              onChange={(e) => patch({ modelId: e.target.value })}
            />

            <label className="field-label">{t('settings.contextWindow')}</label>
            <input
              className="prompt-input cm-input"
              type="number"
              placeholder={t('settings.contextWindowPlaceholder')}
              value={form.maxTokens ?? ''}
              onChange={(e) =>
                patch({
                  maxTokens: e.target.value ? Number(e.target.value) : undefined,
                })
              }
            />

            <label className="cm-check">
              <input
                type="checkbox"
                checked={form.enabled !== false}
                onChange={(e) => patch({ enabled: e.target.checked })}
              />
              {t('settings.enableModel')}
            </label>
          </div>

          <div className="settings-pane-foot">
            <button className="btn" onClick={() => setForm(null)}>
              {t('common.back')}
            </button>
            <button className="btn primary" disabled={busy} onClick={save}>
              {busy ? <span className="spinner" /> : <Icon name="check" size={14} />}
              {t('common.save')}
            </button>
          </div>
        </>
      )}
    </>
  );
}

/* ── MCP 服务器 ──────────────────────────────────────────────────────────────
 * Reads/writes the shared `~/.easycode-user/settings.json` `mcpServers` map (the
 * same store the CLI and every spawned `easycode --acp` backend read), so a
 * server added/edited here is loaded by the next created session. The
 * enable/disable toggle flips membership in the sibling `excludeMCPServers`
 * list, which core honours natively — the desktop counterpart of the VSCode
 * plugin's per-server switch, expressed through shared settings since the
 * desktop's backend is a separate process.
 */

const MCP_TRANSPORTS: Array<{ id: McpTransport; labelKey: TranslationKey }> = [
  { id: 'stdio', labelKey: 'settings.mcpTransportStdio' },
  { id: 'sse', labelKey: 'settings.mcpTransportSse' },
  { id: 'http', labelKey: 'settings.mcpTransportHttp' },
];

/** Editable form state — keeps args/env/headers as raw multi-line text. */
interface McpForm {
  name: string;
  transport: McpTransport;
  command: string;
  argsText: string;
  envText: string;
  cwd: string;
  url: string;
  httpUrl: string;
  headersText: string;
  timeout: string;
  trust: boolean;
  description: string;
  enabled: boolean;
}

const EMPTY_MCP_FORM: McpForm = {
  name: '',
  transport: 'stdio',
  command: '',
  argsText: '',
  envText: '',
  cwd: '',
  url: '',
  httpUrl: '',
  headersText: '',
  timeout: '',
  trust: false,
  description: '',
  enabled: true,
};

/** Split a textarea into trimmed, non-empty lines. */
function toLines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Parse `KEY=VALUE` lines into an object (first `=` splits; later ones kept). */
function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of toLines(text)) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

/** Parse `KEY: VALUE` header lines into an object. */
function parseHeaders(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of toLines(text)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    out[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return out;
}

function recordToLines(rec: Record<string, string> | undefined, sep: string): string {
  if (!rec) return '';
  return Object.entries(rec)
    .map(([k, v]) => `${k}${sep}${v}`)
    .join('\n');
}

function entryToForm(s: McpServerEntry): McpForm {
  return {
    name: s.name,
    transport: s.transport,
    command: s.command ?? '',
    argsText: (s.args ?? []).join('\n'),
    envText: recordToLines(s.env, '='),
    cwd: s.cwd ?? '',
    url: s.url ?? '',
    httpUrl: s.httpUrl ?? '',
    headersText: recordToLines(s.headers, ': '),
    timeout: typeof s.timeout === 'number' ? String(s.timeout) : '',
    trust: s.trust === true,
    description: s.description ?? '',
    enabled: s.enabled !== false,
  };
}

function formToInput(f: McpForm): McpServerInput {
  const args = toLines(f.argsText);
  const env = parseEnv(f.envText);
  const headers = parseHeaders(f.headersText);
  const timeout = f.timeout.trim() ? Number(f.timeout) : undefined;
  return {
    name: f.name.trim(),
    transport: f.transport,
    command: f.command,
    args: args.length ? args : undefined,
    env: Object.keys(env).length ? env : undefined,
    cwd: f.cwd,
    url: f.url,
    httpUrl: f.httpUrl,
    headers: Object.keys(headers).length ? headers : undefined,
    timeout: typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0 ? timeout : undefined,
    trust: f.trust,
    description: f.description,
    enabled: f.enabled,
  };
}

function McpSection() {
  const t = useT();
  const [servers, setServers] = useState<McpServerEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<McpForm | null>(null);
  /** name of the server being edited (undefined when adding). */
  const [editingName, setEditingName] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const refresh = async () => {
    setLoading(true);
    const list = await api.mcp.list();
    setServers(list);
    setLoading(false);
  };

  useEffect(() => {
    void refresh();
  }, []);

  const startAdd = () => {
    setError('');
    setEditingName(undefined);
    setForm({ ...EMPTY_MCP_FORM });
  };

  const startEdit = (s: McpServerEntry) => {
    setError('');
    setEditingName(s.name);
    setForm(entryToForm(s));
  };

  const remove = async (s: McpServerEntry) => {
    await api.mcp.delete(s.name);
    await refresh();
  };

  /** Flip a server's enabled state inline (without opening the editor). */
  const toggleEnabled = async (s: McpServerEntry) => {
    await api.mcp.setEnabled(s.name, !s.enabled);
    await refresh();
  };

  const save = async () => {
    if (!form) return;
    if (!form.name.trim()) return setError(t('settings.errMcpName'));
    if (form.transport === 'stdio' && !form.command.trim()) return setError(t('settings.errMcpCommand'));
    if (form.transport === 'sse' && !form.url.trim()) return setError(t('settings.errMcpUrl'));
    if (form.transport === 'http' && !form.httpUrl.trim()) return setError(t('settings.errMcpUrl'));
    setBusy(true);
    setError('');
    const res = await api.mcp.save(formToInput(form), editingName);
    setBusy(false);
    if (!res.ok) {
      setError(res.error ?? t('settings.saveFailed'));
      return;
    }
    setForm(null);
    setEditingName(undefined);
    await refresh();
  };

  const patch = (p: Partial<McpForm>) => setForm((f) => (f ? { ...f, ...p } : f));

  return (
    <>
      {error && (
        <div className="login-err">
          <Icon name="alert" size={15} />
          {error}
        </div>
      )}

      {!form && (
        <>
          <div className="setting-desc" style={{ marginBottom: 12 }}>
            {t('settings.mcpDesc')}
          </div>
          <div className="cm-list">
            {loading && (
              <div className="cm-empty">
                <span className="spinner" /> {t('common.loading')}
              </div>
            )}
            {!loading && servers.length === 0 && (
              <div className="cm-empty">{t('settings.noMcpServers')}</div>
            )}
            {servers.map((s) => (
              <div className="cm-row" key={s.name}>
                <div className="cm-row-main">
                  <span className="cm-name">{s.name}</span>
                  <span className="cm-badge">{s.transport}</span>
                  {!s.enabled && <span className="cm-badge muted">{t('settings.mcpDisabled')}</span>}
                </div>
                <div className="cm-row-sub">
                  {s.transport === 'stdio'
                    ? [s.command, ...(s.args ?? [])].filter(Boolean).join(' ')
                    : s.url || s.httpUrl}
                </div>
                <div className="cm-actions">
                  <label
                    className="mcp-toggle"
                    title={s.enabled ? t('settings.mcpDisabled') : t('settings.mcpEnableServer')}
                  >
                    <input
                      type="checkbox"
                      checked={s.enabled}
                      onChange={() => void toggleEnabled(s)}
                    />
                  </label>
                  <button className="icon-btn" title={t('common.edit')} onClick={() => startEdit(s)}>
                    <Icon name="edit" size={14} />
                  </button>
                  <button className="icon-btn" title={t('common.delete')} onClick={() => void remove(s)}>
                    <Icon name="delete" size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
          <button className="btn" onClick={startAdd}>
            <Icon name="plus" size={14} />
            {t('settings.addMcpServer')}
          </button>
        </>
      )}

      {form && (
        <>
          <div className="cm-form">
            <label className="field-label">{t('settings.name')}</label>
            <input
              className="prompt-input cm-input"
              placeholder={t('settings.mcpNamePlaceholder')}
              value={form.name}
              onChange={(e) => patch({ name: e.target.value })}
            />

            <label className="field-label">{t('settings.mcpTransport')}</label>
            <div className="prompt-config">
              {MCP_TRANSPORTS.map((tr) => (
                <span
                  key={tr.id}
                  className={`chip interactive ${form.transport === tr.id ? 'accent' : ''}`}
                  onClick={() => patch({ transport: tr.id })}
                >
                  {form.transport === tr.id && <Icon name="check" size={13} />}
                  {t(tr.labelKey)}
                </span>
              ))}
            </div>

            {form.transport === 'stdio' && (
              <>
                <label className="field-label">{t('settings.mcpCommand')}</label>
                <input
                  className="prompt-input cm-input"
                  placeholder={t('settings.mcpCommandPlaceholder')}
                  value={form.command}
                  onChange={(e) => patch({ command: e.target.value })}
                />

                <label className="field-label">{t('settings.mcpArgs')}</label>
                <textarea
                  className="prompt-input cm-input"
                  rows={3}
                  spellCheck={false}
                  placeholder={t('settings.mcpArgsPlaceholder')}
                  value={form.argsText}
                  onChange={(e) => patch({ argsText: e.target.value })}
                />

                <label className="field-label">{t('settings.mcpEnv')}</label>
                <textarea
                  className="prompt-input cm-input"
                  rows={2}
                  spellCheck={false}
                  placeholder={t('settings.mcpEnvPlaceholder')}
                  value={form.envText}
                  onChange={(e) => patch({ envText: e.target.value })}
                />

                <label className="field-label">{t('settings.mcpCwd')}</label>
                <input
                  className="prompt-input cm-input"
                  value={form.cwd}
                  onChange={(e) => patch({ cwd: e.target.value })}
                />
              </>
            )}

            {form.transport === 'sse' && (
              <>
                <label className="field-label">{t('settings.mcpUrl')}</label>
                <input
                  className="prompt-input cm-input"
                  placeholder="https://example.com/sse"
                  value={form.url}
                  onChange={(e) => patch({ url: e.target.value })}
                />

                <label className="field-label">{t('settings.mcpHeaders')}</label>
                <textarea
                  className="prompt-input cm-input"
                  rows={2}
                  spellCheck={false}
                  placeholder={t('settings.mcpHeadersPlaceholder')}
                  value={form.headersText}
                  onChange={(e) => patch({ headersText: e.target.value })}
                />
              </>
            )}

            {form.transport === 'http' && (
              <>
                <label className="field-label">{t('settings.mcpUrl')}</label>
                <input
                  className="prompt-input cm-input"
                  placeholder="https://example.com/mcp"
                  value={form.httpUrl}
                  onChange={(e) => patch({ httpUrl: e.target.value })}
                />

                <label className="field-label">{t('settings.mcpHeaders')}</label>
                <textarea
                  className="prompt-input cm-input"
                  rows={2}
                  spellCheck={false}
                  placeholder={t('settings.mcpHeadersPlaceholder')}
                  value={form.headersText}
                  onChange={(e) => patch({ headersText: e.target.value })}
                />
              </>
            )}

            <label className="field-label">{t('settings.mcpTimeout')}</label>
            <input
              className="prompt-input cm-input"
              type="number"
              placeholder={t('settings.mcpTimeoutPlaceholder')}
              value={form.timeout}
              onChange={(e) => patch({ timeout: e.target.value })}
            />

            <label className="field-label">{t('settings.mcpDescription')}</label>
            <input
              className="prompt-input cm-input"
              value={form.description}
              onChange={(e) => patch({ description: e.target.value })}
            />

            <label className="cm-check">
              <input
                type="checkbox"
                checked={form.trust}
                onChange={(e) => patch({ trust: e.target.checked })}
              />
              {t('settings.mcpTrust')}
            </label>

            <label className="cm-check">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(e) => patch({ enabled: e.target.checked })}
              />
              {t('settings.mcpEnableServer')}
            </label>
          </div>

          <div className="settings-pane-foot">
            <button className="btn" onClick={() => setForm(null)}>
              {t('common.back')}
            </button>
            <button className="btn primary" disabled={busy} onClick={save}>
              {busy ? <span className="spinner" /> : <Icon name="check" size={14} />}
              {t('common.save')}
            </button>
          </div>
        </>
      )}
    </>
  );
}

/* ── 已归档会话 ──────────────────────────────────────────────────────────────
 * Manage archived sessions in one place (they no longer appear in the sidebar):
 * search + filter by type/project, unarchive or permanently delete a single one,
 * bulk-delete a whole project, or delete them all. Drives the same store actions
 * (archiveSession / deleteSession) the sidebar used to.
 */
type ArchTypeFilter = 'all' | 'chat' | 'project';

/** A confirm-gated destructive action: the ids to delete + a display label. */
interface PendingDelete {
  label: string;
  ids: string[];
}

/** Collapse key + display bucket for the single Chats group. */
const ARCH_CHATS_KEY = '__chats__';

function archProjectName(cwd: string): string {
  const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || cwd;
}

function formatArchDate(ts: number, lang: string): string {
  return new Date(ts).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

interface ArchGroup {
  key: string;
  name: string;
  kind: SessionKind;
  metas: SessionMeta[];
}

function ArchivedChatsSection() {
  const t = useT();
  const lang = useStore((s) => s.lang);
  const sessions = useStore((s) => s.sessions);
  const order = useStore((s) => s.order);
  const archiveSession = useStore((s) => s.archiveSession);
  const deleteSession = useStore((s) => s.deleteSession);

  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<ArchTypeFilter>('all');
  const [projectFilter, setProjectFilter] = useState('');
  const [pending, setPending] = useState<PendingDelete | null>(null);
  const [busy, setBusy] = useState(false);
  const [openMenu, setOpenMenu] = useState<string | null>(null);

  const archived = useMemo(
    () => order.map((id) => sessions[id]?.meta).filter((m): m is SessionMeta => !!m && m.archived),
    [order, sessions],
  );

  // Project options for the project filter (only projects that have archived chats).
  const projectOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const m of archived) if (m.kind === 'project') seen.set(m.cwd, archProjectName(m.cwd));
    return [
      { value: '', label: t('settings.archivedAllProjects') },
      ...[...seen.entries()].map(([value, label]) => ({ value, label })),
    ];
  }, [archived, t]);

  const q = query.trim().toLowerCase();
  const groups = useMemo<ArchGroup[]>(() => {
    const filtered = archived.filter((m) => {
      if (typeFilter === 'chat' && m.kind !== 'chat') return false;
      if (typeFilter === 'project' && m.kind !== 'project') return false;
      if (projectFilter && m.cwd !== projectFilter) return false;
      if (q && !m.title.toLowerCase().includes(q)) return false;
      return true;
    });
    const map = new Map<string, ArchGroup>();
    for (const m of filtered) {
      const key = m.kind === 'chat' ? ARCH_CHATS_KEY : m.cwd;
      let g = map.get(key);
      if (!g) {
        g = {
          key,
          name: m.kind === 'chat' ? t('sidebar.chatsFolder') : archProjectName(m.cwd),
          kind: m.kind,
          metas: [],
        };
        map.set(key, g);
      }
      g.metas.push(m);
    }
    return [...map.values()];
  }, [archived, typeFilter, projectFilter, q, t]);

  const runDelete = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      for (const id of pending.ids) await deleteSession(id);
      setPending(null);
    } finally {
      setBusy(false);
    }
  };

  const unarchiveAll = async (ids: string[]) => {
    for (const id of ids) await archiveSession(id, false);
  };

  const typeOptions: { value: ArchTypeFilter; label: string }[] = [
    { value: 'all', label: t('settings.archivedAllChats') },
    { value: 'chat', label: t('sidebar.chatsFolder') },
    { value: 'project', label: t('sidebar.projects') },
  ];

  return (
    <>
      <div className="arch-toolbar">
        <div className="arch-search">
          <Icon name="search" size={14} className="ic" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('settings.archivedSearchPlaceholder')}
          />
        </div>
        <FilterSelect
          icon="tasks"
          value={typeFilter}
          options={typeOptions}
          onChange={(v) => setTypeFilter(v as ArchTypeFilter)}
        />
        <FilterSelect
          icon="folder"
          value={projectFilter}
          options={projectOptions}
          onChange={setProjectFilter}
        />
        <button
          className="btn danger arch-delete-all"
          disabled={archived.length === 0}
          onClick={() =>
            setPending({ label: t('settings.archivedDeleteAll'), ids: archived.map((m) => m.id) })
          }
        >
          <Icon name="delete" size={14} />
          {t('settings.archivedDeleteAll')}
        </button>
      </div>

      {archived.length === 0 ? (
        <div className="cm-empty">{t('settings.archivedEmpty')}</div>
      ) : groups.length === 0 ? (
        <div className="cm-empty">{t('settings.archivedNoMatch')}</div>
      ) : (
        <div className="arch-list">
          {groups.map((g) => (
            <div className="arch-group" key={g.key}>
              <div className="arch-group-head">
                <Icon name="folder" size={14} className="arch-group-ic" />
                <span className="arch-group-name">{g.name}</span>
                <span className="arch-group-count">
                  {t('settings.archivedChatCount', { n: g.metas.length })}
                </span>
                <div className="arch-group-menu-wrap">
                  <button
                    className="icon-btn"
                    title={t('common.more')}
                    onClick={() => setOpenMenu((m) => (m === g.key ? null : g.key))}
                  >
                    <Icon name="wrench" size={14} />
                  </button>
                  {openMenu === g.key && (
                    <>
                      <div className="arch-menu-veil" onClick={() => setOpenMenu(null)} />
                      <div className="menu-pop arch-menu">
                        <button
                          onClick={() => {
                            setOpenMenu(null);
                            void unarchiveAll(g.metas.map((m) => m.id));
                          }}
                        >
                          <Icon name="archive-restore" size={14} />
                          <span className="grow">{t('settings.archivedUnarchiveAll')}</span>
                        </button>
                        <button
                          className="danger"
                          onClick={() => {
                            setOpenMenu(null);
                            setPending({
                              label: t('settings.archivedDeleteProject', { name: g.name }),
                              ids: g.metas.map((m) => m.id),
                            });
                          }}
                        >
                          <Icon name="delete" size={14} />
                          <span className="grow">{t('settings.archivedDeleteProjectShort')}</span>
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </div>
              {g.metas.map((m) => (
                <div className="arch-row" key={m.id}>
                  <div className="arch-row-main">
                    <span className="arch-row-title">{m.title}</span>
                    <span className="arch-row-date">{formatArchDate(m.updatedAt, lang)}</span>
                  </div>
                  <div className="arch-row-actions">
                    <button
                      className="icon-btn"
                      title={t('sidebar.unarchive')}
                      onClick={() => void archiveSession(m.id, false)}
                    >
                      <Icon name="archive-restore" size={14} />
                    </button>
                    <button
                      className="icon-btn danger"
                      title={t('sidebar.delete')}
                      onClick={() => setPending({ label: m.title, ids: [m.id] })}
                    >
                      <Icon name="delete" size={14} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {pending && (
        <div className="modal-backdrop" onClick={() => !busy && setPending(null)}>
          <div className="modal modal-sm" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>
                <Icon name="delete" size={17} />
                {t('sidebar.deleteTitle')}
              </h3>
              <div className="sub">
                {pending.ids.length > 1
                  ? t('settings.archivedDeleteCountConfirm', { n: pending.ids.length })
                  : t('sidebar.deleteConfirm', { title: pending.label })}
              </div>
            </div>
            <div className="modal-body">
              <div className="sub">{t('sidebar.deleteWarning')}</div>
            </div>
            <div className="modal-foot">
              <button className="btn" disabled={busy} onClick={() => setPending(null)}>
                {t('common.cancel')}
              </button>
              <button className="btn danger" disabled={busy} onClick={() => void runDelete()}>
                {busy ? <span className="spinner" /> : <Icon name="delete" size={14} />}
                {t('sidebar.delete')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * Compact dropdown for the archived-chats filters (type / project). Mirrors
 * `ShellSelect`'s look (`.shell-select` + `.menu-pop`).
 */
function FilterSelect({
  value,
  options,
  icon,
  onChange,
}: {
  value: string;
  options: { value: string; label: string }[];
  icon: IconName;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const current = options.find((o) => o.value === value)?.label ?? options[0]?.label ?? '';

  return (
    <div className="shell-select arch-filter" ref={ref}>
      <button className="shell-select-trigger" onClick={() => setOpen((o) => !o)}>
        <Icon name={icon} size={14} />
        <span className="grow">{current}</span>
        <Icon name="chevron-down" size={13} />
      </button>
      {open && (
        <div className="menu-pop" style={{ left: 0, top: '110%', minWidth: 200, maxHeight: 300, overflowY: 'auto' }}>
          {options.map((o) => (
            <button
              key={o.value}
              onClick={() => {
                onChange(o.value);
                setOpen(false);
              }}
            >
              <span className="grow">{o.label}</span>
              <Icon name="check" className={value === o.value ? 'shell-check' : 'placeholder'} size={14} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
