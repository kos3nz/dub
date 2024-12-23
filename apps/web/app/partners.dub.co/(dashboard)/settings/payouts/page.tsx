import { PageContent } from "@/ui/layout/page-content";
import { MaxWidthWrapper } from "@dub/ui";
import { PayoutsSettingsPageClient } from "./page-client";

export default function PayoutsSettings() {
  return (
    <PageContent title="Payouts" hideReferButton>
      <MaxWidthWrapper>
        <PayoutsSettingsPageClient />
      </MaxWidthWrapper>
    </PageContent>
  );
}
