import { useCallback, useEffect, useRef, useState } from "react";

// One attendee per device. Every tab on a device already shares the same anonymous participant
// id (localStorage); this makes only one of them active at a time. The newest tab takes over and
// older tabs show "open in another tab — use it here". Works in browsers with BroadcastChannel;
// elsewhere every tab stays active (still one voter, since the id is shared).

type Msg = { type: "claim"; tab: string };

export function useSingleTab(channelName: string): { active: boolean; takeOver: () => void } {
  const [active, setActive] = useState(true);
  const tab = useRef(Math.random().toString(36).slice(2));
  const channel = useRef<BroadcastChannel | null>(null);

  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const ch = new BroadcastChannel(channelName);
    channel.current = ch;
    ch.onmessage = (e: MessageEvent<Msg>) => {
      if (e.data?.type === "claim" && e.data.tab !== tab.current) setActive(false);
    };
    ch.postMessage({ type: "claim", tab: tab.current } satisfies Msg);
    return () => {
      ch.close();
      channel.current = null;
    };
  }, [channelName]);

  const takeOver = useCallback(() => {
    channel.current?.postMessage({ type: "claim", tab: tab.current } satisfies Msg);
    setActive(true);
  }, []);

  return { active, takeOver };
}
