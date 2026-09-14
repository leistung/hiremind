import { createContext, useContext, useEffect, useRef, useState, type ReactNode, type SetStateAction } from "react";
import { community, type Preparation, type User } from "./community";

const empty: Preparation = { saved: [], notes: [], tasks: [], drafts: [] };
type Account = { user: User | null; data: Preparation; status: string; setField: <T>(key: keyof Preparation, value: SetStateAction<T>) => void; login: () => void; logout: () => Promise<void> };
const AccountContext = createContext<Account>(null!);
export const useAccount = () => useContext(AccountContext);

export function useAccountField<T>(key: string, _initial: T) {
  const account = useAccount();
  const field = key.replace("hiremind.prep.", "") as keyof Preparation;
  return [account.data[field] as T, (value: SetStateAction<T>) => account.setField(field, value)] as const;
}

function localImport(): Preparation {
  const read = (field: string) => { try { const value = JSON.parse(localStorage.getItem(`hiremind.prep.${field}`) || "[]"); return Array.isArray(value) ? value : []; } catch { return []; } };
  return { saved: read("saved"), notes: read("notes"), tasks: read("tasks"), drafts: read("drafts") };
}

export function AccountProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<Preparation>(empty);
  const [dialog, setDialog] = useState(false);
  const [status, setStatus] = useState("尚未登录");
  const [fatal, setFatal] = useState("");
  const current = useRef(data);
  const revision = useRef(0);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const fault = useRef(false);
  const userRef = useRef<User | null>(null);

  const load = async (account: User) => {
    let state = await community.preparation();
    if (account.email === "root@hiremind.local") state = await community.importLocal(localImport());
    current.current = state; revision.current = state.revision;
    dirty.current = false; fault.current = false;
    userRef.current = account; setUser(account); setData(state); setStatus("已保存到账户");
  };
  useEffect(() => {
    void community.me().then(load).catch(() => { community.logout(); setStatus("请登录后保存个人内容"); }).finally(() => setLoading(false));
    return () => clearTimeout(timer.current);
  }, []);

  const flush = () => {
    clearTimeout(timer.current);
    queue.current = queue.current.then(async () => {
      if (!dirty.current || !userRef.current || fault.current) return;
      const snapshot = current.current;
      dirty.current = false;
      setStatus("正在保存…");
      try {
        const result = await community.savePreparation({ ...snapshot, revision: revision.current });
        revision.current = result.revision;
        setStatus(dirty.current ? "等待保存…" : "已保存到账户");
      } catch (error) {
        fault.current = true; dirty.current = true;
        localStorage.setItem(`hiremind.recovery.${userRef.current.id}`, JSON.stringify(current.current));
        setStatus("保存失败：" + (error as Error).message + "；修改已保留为本机恢复副本");
      }
    });
    return queue.current;
  };

  const setField: Account["setField"] = (key, value) => {
    if (!userRef.current) { setDialog(true); return; }
    const next = typeof value === "function" ? (value as (value: unknown) => unknown)(current.current[key]) : value;
    current.current = { ...current.current, [key]: next };
    setData(current.current); dirty.current = true; setStatus("等待保存…");
    clearTimeout(timer.current); timer.current = setTimeout(() => void flush(), 500);
  };
  useEffect(() => { const warn = (event: BeforeUnloadEvent) => { if (dirty.current) { event.preventDefault(); } }; window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn); }, []);
  const logout = async () => {
    await flush();
    if (dirty.current) { setFatal("尚有修改未成功保存，请先处理保存错误后退出。"); return; }
    try { await community.endSession(); community.logout(); setUser(null); userRef.current = null; current.current = empty; setData(empty); setStatus("尚未登录"); } catch { setFatal("退出失败，请稍后重试。"); }
  };
  if (loading) return <div className="account-loading">正在连接你的工作区…</div>;
  return <AccountContext.Provider value={{ user, data, status, setField, login: () => setDialog(true), logout }}>
    {fatal && <div className="account-error" role="alert">{fatal}<button onClick={() => setFatal("")}>关闭</button></div>}
    {children}
    {dialog && <LoginDialog close={() => setDialog(false)} done={async account => { await load(account); setDialog(false); }}/ >}
  </AccountContext.Provider>;
}

function LoginDialog({ close, done }: { close: () => void; done: (user: User) => Promise<void> }) {
  const [register, setRegister] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return <div className="auth-backdrop"><form className="auth-dialog" onSubmit={async event => {
    event.preventDefault(); setBusy(true); setError("");
    try { const auth = register ? await community.register({ email, password, display_name: name }) : await community.login({ email, password }); community.persist(auth); await done(auth.user); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }}><button type="button" className="auth-close" aria-label="关闭登录" onClick={close}>×</button><p>HIREMIND ACCOUNT</p><h2>{register ? "创建个人账号" : "回到你的工作区"}</h2><span>简历、笔记和学习计划，保存在你的账号中。</span>{register && <input aria-label="显示名称" value={name} onChange={e => setName(e.target.value)} required maxLength={80} placeholder="显示名称"/>}<input aria-label="账号" autoComplete="username" type={register ? "email" : "text"} value={email} onChange={e => setEmail(e.target.value)} placeholder={register ? "邮箱" : "账号或邮箱"} required/><input aria-label="密码" autoComplete={register ? "new-password" : "current-password"} type="password" minLength={register ? 8 : 1} maxLength={128} value={password} onChange={e => setPassword(e.target.value)} placeholder="密码" required/>{error && <small className="auth-error" role="alert">{error}</small>}<button className="auth-submit" disabled={busy}>{busy ? "正在连接…" : register ? "注册并登录" : "登录"}</button><button className="auth-toggle" type="button" onClick={() => { setRegister(!register); setError(""); }}>{register ? "已有账号，去登录" : "创建一个新账号"}</button></form></div>;
}
