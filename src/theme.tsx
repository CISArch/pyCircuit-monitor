import { App as AntApp, ConfigProvider, theme as antdTheme } from "antd";
import { useEffect, useState, type ReactNode } from "react";

/** 跟随系统 prefers-color-scheme，实时响应切换。 */
export function useSystemDark(): boolean {
  const [dark, setDark] = useState<boolean>(() =>
    typeof window !== "undefined" && window.matchMedia
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
      : true,
  );
  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => setDark(e.matches);
    setDark(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return dark;
}

export function ThemeShell({ children }: { children: ReactNode }) {
  const dark = useSystemDark();
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  }, [dark]);
  return (
    <ConfigProvider
      theme={{
        algorithm: dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
        token: {
          colorPrimary: dark ? "#4dd0e1" : "#0e7490",
          borderRadius: 8,
          fontSize: 13,
          fontFamily:
            '-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif',
        },
        components: {
          Table: { cellPaddingBlockSM: 6, cellPaddingInlineSM: 10, headerBg: dark ? "#121822" : undefined },
          Card: { bodyPadding: 14 },
        },
      }}
    >
      <AntApp>{children}</AntApp>
    </ConfigProvider>
  );
}
