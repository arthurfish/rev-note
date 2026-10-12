import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatRelativeDate(value?: string) {
  if (!value) return "刚刚";
  const date = new Date(value);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(date);
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "昨天";
  if (date.getFullYear() === now.getFullYear()) return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(date);
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "short", day: "numeric" }).format(date);
}

export function formatFullDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

export function excerpt(content: string, length = 72) {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (normalized.length <= length) return normalized || "空白笔记";
  return `${normalized.slice(0, length)}…`;
}
