import { useEffect, useState } from "react";
import { background } from "@/lib/background";
import { Button } from "@/components/ui/button";
import { servicesReceivingPages } from "../../modules/shared/settings/model";

/**
 * Asked before the first translation, since that is when page text first leaves the browser: it
 * says where the text goes, naming the reader's connections as the quick settings panel sees them,
 * and nothing is sent until the reader agrees.
 */
export function DataConsent({ onAccept, onCancel }: { onAccept: () => void; onCancel: () => void }) {
  const [services, setServices] = useState<string[]>([]);

  useEffect(() => {
    let current = true;
    // Without names the prompt still says where the text goes, just not by name.
    background.request({ type: "quick-settings" }).then(
      (reply) => { if (current && reply.status === "ok") setServices(servicesReceivingPages(reply.settings)); },
      () => {},
    );
    return () => { current = false; };
  }, []);

  return (
    <div className="flex flex-col gap-3 p-4" translate="no">
      <h2 className="text-sm font-semibold">翻译前请确认</h2>
      <p className="text-[13px] leading-relaxed text-muted-foreground">
        翻译时，本页的文字和标题会发送给你在设置中选择的模型服务
        {services.length > 0 && <>（<span className="text-foreground">{services.join("、")}</span>）</>}
        ，由它生成译文。不会发给开发者或其他任何地方。同意后不再询问。
      </p>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>取消</Button>
        <Button type="button" size="sm" onClick={onAccept}>同意并翻译</Button>
      </div>
    </div>
  );
}
