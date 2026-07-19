// 前端工具函数

export function formatDate(iso: string): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
      d.getDate(),
    ).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(
      d.getMinutes(),
    ).padStart(2, "0")}`;
  } catch {
    return iso;
  }
}

export function relativeTime(iso: string): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    const now = Date.now();
    const diff = now - d.getTime();
    const min = Math.floor(diff / 60000);
    if (min < 1) return "刚刚";
    if (min < 60) return `${min} 分钟前`;
    const hour = Math.floor(min / 60);
    if (hour < 24) return `${hour} 小时前`;
    const day = Math.floor(hour / 24);
    if (day < 30) return `${day} 天前`;
    return formatDate(iso).split(" ")[0];
  } catch {
    return iso;
  }
}

export function scoreColor(score: number, max = 100): string {
  const ratio = score / max;
  if (ratio >= 0.8) return "success";
  if (ratio >= 0.6) return "warning";
  return "danger";
}

export function severityLevel(sev: string): "high" | "mid" | "low" {
  const s = sev.toLowerCase();
  if (s.includes("高") || s.includes("high")) return "high";
  if (s.includes("中") || s.includes("mid")) return "mid";
  return "low";
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function downloadReport(filename: string, downloadUrl: string) {
  try {
    const res = await fetch(downloadUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    downloadBlob(blob, filename);
  } catch (e) {
    window.open(downloadUrl, "_blank");
  }
}

export function emptyResumeData() {
  return {
    basics: {
      name: "",
      phone: "",
      email: "",
      location: "",
      title: "",
      summary: "",
      photo: "",
    },
    education: [],
    experiences: [],
    projects: [],
    skills: [],
    template: "classic",
  };
}
