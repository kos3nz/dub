"use client";

import { createManualPayoutAction } from "@/lib/actions/partners/create-manual-payout";
import { AnalyticsResponseOptions } from "@/lib/analytics/types";
import { calculateEarnings } from "@/lib/api/sales/commission";
import usePartners from "@/lib/swr/use-partners";
import useProgram from "@/lib/swr/use-program";
import useWorkspace from "@/lib/swr/use-workspace";
import { createManualPayoutSchema } from "@/lib/zod/schemas/payouts";
import { X } from "@/ui/shared/icons";
import {
  Button,
  Combobox,
  DateRangePicker,
  Sheet,
  useEnterSubmit,
  useRouterStuff,
} from "@dub/ui";
import {
  capitalize,
  cn,
  currencyFormatter,
  DICEBEAR_AVATAR_URL,
  fetcher,
  formatDate,
} from "@dub/utils";
import { nFormatter } from "@dub/utils/src/functions";
import { zodResolver } from "@hookform/resolvers/zod";
import { PayoutType } from "@prisma/client";
import {
  endOfMonth,
  endOfQuarter,
  endOfYear,
  startOfMonth,
  startOfQuarter,
  startOfYear,
  subMonths,
} from "date-fns";
import { useAction } from "next-safe-action/hooks";
import {
  Dispatch,
  Fragment,
  ReactNode,
  SetStateAction,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import useSWR, { mutate } from "swr";
import { z } from "zod";

interface CreatePayoutSheetProps {
  setIsOpen: Dispatch<SetStateAction<boolean>>;
}

const schema = createManualPayoutSchema
  .pick({
    partnerId: true,
    type: true,
    amount: true,
    description: true,
  })
  .and(
    z.object({
      start: z.date().optional(),
      end: z.date().optional(),
    }),
  )
  .refine(
    (data) => {
      return data.type === "custom" || (data.start && data.end);
    },
    {
      message: "Please select a date range",
      path: ["start"],
    },
  );

type FormData = z.infer<typeof schema>;

function CreatePayoutSheetContent({ setIsOpen }: CreatePayoutSheetProps) {
  const dateRangePickerId = useId();
  const { program } = useProgram();
  const { data: partners } = usePartners();
  const { id: workspaceId } = useWorkspace();
  const { queryParams } = useRouterStuff();

  const formRef = useRef<HTMLFormElement>(null);
  const { handleKeyDown } = useEnterSubmit(formRef);

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    clearErrors,
    formState: { errors },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: {
      type: "sales",
      amount:
        program?.commissionType === "flat"
          ? Number(program?.commissionAmount) / 100
          : program?.commissionAmount,
    },
  });

  const { partnerId, type: payoutType, start, end, amount } = watch();

  const isPercentageBased =
    payoutType === "sales" && program?.commissionType === "percentage";

  const partnerOptions = useMemo(() => {
    return partners?.map((partner) => ({
      value: partner.id,
      label: partner.name,
      icon: (
        <img
          src={
            partner.image ||
            `https://api.dicebear.com/9.x/micah/svg?seed=${partner.id}`
          }
          className="size-4 rounded-full"
        />
      ),
    }));
  }, [partners]);

  const { executeAsync, isExecuting } = useAction(createManualPayoutAction, {
    onSuccess: async (res) => {
      toast.success("Successfully created payout!");
      setIsOpen(false);
      await mutate(
        (key) =>
          typeof key === "string" &&
          key.startsWith(`/api/programs/${program?.id}/payouts`),
        undefined,
        { revalidate: true },
      );

      const payoutId = res.data?.id;

      if (payoutId) {
        queryParams({ set: { payoutId } });
      }
    },
    onError({ error }) {
      toast.error(error.serverError);
    },
  });

  const onSubmit = async (data: FormData) => {
    if (workspaceId && program) {
      const startDate = data.start
        ? data.start.getTime() - data.start.getTimezoneOffset() * 60000
        : undefined;
      const endDate = data.end
        ? data.end.getTime() - data.end.getTimezoneOffset() * 60000
        : undefined;

      await executeAsync({
        ...data,
        workspaceId,
        programId: program.id,
        start: startDate ? new Date(startDate).toISOString() : undefined,
        end: endDate ? new Date(endDate).toISOString() : undefined,
        amount: isPercentageBased ? amount : amount * 100,
      });
    }
  };

  const selectedPartner = partners?.find((p) => p.id === partnerId);

  const salesSearchParams = useMemo(
    () =>
      new URLSearchParams({
        workspaceId: workspaceId!,
        partnerId: selectedPartner?.id || "",
        start: start?.toISOString() || "",
        end: end?.toISOString() || "",
      }),
    [workspaceId, selectedPartner?.id, start, end],
  );

  const shouldRequestSales = useMemo(
    () => !!(payoutType === "sales" && start && end && selectedPartner?.link),
    [payoutType, start, end, selectedPartner?.link],
  );

  const { data: totalEvents, isValidating } = useSWR<{
    [key in AnalyticsResponseOptions]: number;
  }>(
    payoutType !== "custom" &&
      payoutType !== "sales" &&
      start &&
      end &&
      selectedPartner?.link &&
      `/api/analytics?${new URLSearchParams({
        workspaceId: workspaceId!,
        event: payoutType,
        linkId: selectedPartner.link.id,
        start: start?.toISOString(),
        end: end?.toISOString(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }).toString()}`,
    fetcher,
  );

  const { data: salesAmount, isValidating: isValidatingSalesAmount } = useSWR<{
    amount: number;
  }>(
    shouldRequestSales &&
      `/api/programs/${program?.id}/sales/amount?${salesSearchParams.toString()}`,
    fetcher,
  );

  const { data: salesCount, isValidating: isValidatingSalesCount } = useSWR<{
    pending: number;
    duplicate: number;
    fraud: number;
  }>(
    shouldRequestSales &&
      `/api/programs/${program?.id}/sales/count?${salesSearchParams.toString()}`,
    fetcher,
  );

  const payoutAmount = useMemo(() => {
    const quantity =
      payoutType === "sales" ? salesCount?.pending : totalEvents?.[payoutType];

    if (payoutType === "custom") {
      return amount;
    }

    if (isPercentageBased && salesAmount?.amount) {
      return (
        calculateEarnings({
          program: {
            commissionAmount: amount,
            commissionType: "percentage",
          },
          sales: 1,
          saleAmount: salesAmount.amount,
        }) / 100
      );
    }

    return quantity && amount ? quantity * amount : undefined;
  }, [
    payoutType,
    salesCount,
    totalEvents,
    amount,
    isPercentageBased,
    salesAmount,
    program,
  ]);

  const invoiceData = useMemo(() => {
    const quantity =
      payoutType === "sales" ? salesCount?.pending : totalEvents?.[payoutType];

    const amountAsNumber = amount ? Number(amount) : undefined;

    return {
      ...(selectedPartner && {
        Partner: (
          <div className="flex items-center gap-2">
            <img
              src={
                selectedPartner.image ||
                `${DICEBEAR_AVATAR_URL}${selectedPartner.id}`
              }
              alt={selectedPartner.name}
              className="size-5 rounded-full"
            />
            <div>{selectedPartner.name}</div>
          </div>
        ),
      }),

      ...(start &&
        end && {
          Period: `${formatDate(start, {
            month: "short",
            year:
              new Date(start).getFullYear() === new Date(end).getFullYear()
                ? undefined
                : "numeric",
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          })}-${formatDate(end, { month: "short", timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone })}`,
        }),

      ...(payoutType !== "custom" && {
        [capitalize(payoutType) as string]:
          isValidating || isValidatingSalesCount ? (
            <div className="h-4 w-12 animate-pulse rounded-md bg-neutral-200" />
          ) : (
            nFormatter(quantity, {
              full: true,
            })
          ),

        [`Reward per ${payoutType.replace(/s$/, "")}`]: amountAsNumber
          ? !isPercentageBased
            ? currencyFormatter(amountAsNumber, {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })
            : `${amountAsNumber}%`
          : "-",
      }),

      ...(isPercentageBased && {
        Revenue: isValidatingSalesAmount ? (
          <div className="h-4 w-12 animate-pulse rounded-md bg-neutral-200" />
        ) : salesAmount?.amount ? (
          currencyFormatter(salesAmount.amount / 100, {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })
        ) : (
          "-"
        ),
      }),

      ...(payoutAmount && {
        Amount: isValidating ? (
          <div className="h-4 w-12 animate-pulse rounded-md bg-neutral-200" />
        ) : payoutAmount ? (
          currencyFormatter(payoutAmount, {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })
        ) : null,
        Fee: isValidating ? (
          <div className="h-4 w-12 animate-pulse rounded-md bg-neutral-200" />
        ) : payoutAmount ? (
          currencyFormatter(payoutAmount * 0.02, {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })
        ) : null,
        Total: isValidating ? (
          <div className="h-4 w-12 animate-pulse rounded-md bg-neutral-200" />
        ) : payoutAmount ? (
          <strong>
            {currencyFormatter(payoutAmount * 1.02, {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}
          </strong>
        ) : null,
      }),
    };
  }, [
    selectedPartner,
    partners,
    start,
    end,
    payoutType,
    totalEvents,
    amount,
    isValidating,
    isValidatingSalesAmount,
    isValidatingSalesCount,
    payoutAmount,
  ]);

  const buttonDisabled =
    isExecuting ||
    isValidating ||
    isValidatingSalesAmount ||
    isValidatingSalesCount ||
    !partnerId ||
    !payoutAmount;

  return (
    <form
      ref={formRef}
      onSubmit={handleSubmit(onSubmit)}
      className="flex h-full flex-col"
    >
      <div>
        <div className="flex items-start justify-between border-b border-neutral-200 p-6">
          <Sheet.Title className="text-xl font-semibold">
            Create payout
          </Sheet.Title>
          <Sheet.Close asChild>
            <Button
              variant="outline"
              icon={<X className="size-5" />}
              className="h-auto w-fit p-1"
            />
          </Sheet.Close>
        </div>
        <div className="flex flex-col gap-4 p-6">
          <div className="flex flex-col gap-2">
            <label className="text-sm font-medium text-gray-900">
              Partner
              <span className="font-normal text-neutral-500"> (required)</span>
            </label>
            <Combobox
              selected={
                partnerOptions?.find((o) => o.value === partnerId) ?? null
              }
              setSelected={(option) => {
                if (option) {
                  setValue("partnerId", option.value);
                  clearErrors("partnerId");
                }
              }}
              options={partnerOptions}
              caret={true}
              placeholder="Select partners"
              searchPlaceholder="Search..."
              matchTriggerWidth
              buttonProps={{
                className: cn(
                  "w-full justify-start border-gray-300 px-3",
                  "data-[state=open]:ring-1 data-[state=open]:ring-gray-500 data-[state=open]:border-gray-500",
                  "focus:ring-1 focus:ring-gray-500 focus:border-gray-500 transition-none",
                  !partnerId && "text-gray-400",
                  errors.partnerId && "border-red-500",
                ),
              }}
            />
            {errors.partnerId && (
              <p className="text-xs text-red-600">{errors.partnerId.message}</p>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <label
              htmlFor={dateRangePickerId}
              className="block text-sm font-medium text-gray-700"
            >
              Payout period {payoutType === "custom" ? "(optional)" : ""}
            </label>
            <DateRangePicker
              id={dateRangePickerId}
              value={
                start && end
                  ? {
                      from: start,
                      to: end,
                    }
                  : undefined
              }
              onChange={(range, preset) => {
                if (preset) {
                  setValue("start", preset.dateRange.from);
                  setValue("end", preset.dateRange.to);
                } else if (range) {
                  setValue("start", range.from);
                  setValue("end", range.to);
                }

                clearErrors("start");
                clearErrors("end");
              }}
              align="end"
              presets={[
                {
                  id: "this-month",
                  label: "This month",
                  dateRange: {
                    from: startOfMonth(new Date()),
                    to: endOfMonth(new Date()),
                  },
                },
                {
                  id: "last-month",
                  label: "Last month",
                  dateRange: {
                    from: startOfMonth(subMonths(new Date(), 1)),
                    to: endOfMonth(subMonths(new Date(), 1)),
                  },
                },
                {
                  id: "this-quarter",
                  label: "This quarter",
                  dateRange: {
                    from: startOfQuarter(new Date()),
                    to: endOfQuarter(new Date()),
                  },
                },
                {
                  id: "this-year",
                  label: "This year",
                  dateRange: {
                    from: startOfYear(new Date()),
                    to: endOfYear(new Date()),
                  },
                },
              ]}
              hasError={!!(errors.start || errors.end)}
            />
            {(errors.start || errors.end) && (
              <p className="text-xs text-red-600">{errors.start?.message}</p>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <label
              htmlFor="type"
              className="flex items-center space-x-2 text-sm font-medium text-gray-900"
            >
              Reward type
            </label>
            <select
              {...register("type", { required: true })}
              className="block w-full rounded-md border-gray-300 text-gray-900 placeholder-gray-400 focus:border-gray-500 focus:outline-none focus:ring-gray-500 sm:text-sm"
              onChange={(e) => {
                const type = e.target.value as PayoutType;

                setValue("type", type);

                if (type === "custom") {
                  clearErrors(["start", "end"]);
                }

                if (
                  type === "sales" &&
                  program?.commissionAmount &&
                  program.commissionType === "flat"
                ) {
                  setValue("amount", program.commissionAmount / 100);
                } else {
                  // @ts-ignore
                  setValue("amount", null);
                }
              }}
            >
              {Object.values(PayoutType).map((type) => (
                <option key={type} value={type}>
                  {type.charAt(0).toUpperCase() + type.slice(1)}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label
              htmlFor="amount"
              className="text-sm font-medium text-neutral-800"
            >
              Reward amount
            </label>
            <div className="relative mt-2 rounded-md shadow-sm">
              {!isPercentageBased && (
                <span className="absolute inset-y-0 left-0 flex items-center pl-3 text-sm text-neutral-400">
                  $
                </span>
              )}
              <input
                className={cn(
                  "block w-full rounded-md border-neutral-300 text-neutral-900 placeholder-neutral-400 focus:border-neutral-500 focus:outline-none focus:ring-neutral-500 sm:text-sm",
                  "pr-[6.5rem]",
                  payoutType === "custom" && "pr-12",
                  !isPercentageBased && "pl-6",
                  errors.amount &&
                    "border-red-600 focus:border-red-500 focus:ring-red-600",
                )}
                {...register("amount", {
                  required: true,
                  valueAsNumber: true,
                })}
                autoComplete="off"
                placeholder="5"
              />
              <span className="absolute inset-y-0 right-0 flex items-center pr-3 text-sm text-neutral-400">
                {isPercentageBased ? "%" : "USD"}
                {payoutType !== "custom" &&
                  ` per ${payoutType.replace(/s$/, "")}`}
              </span>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <label
              htmlFor="description"
              className="flex items-center space-x-2 text-sm font-medium text-gray-900"
            >
              Description (optional)
            </label>
            <textarea
              {...register("description")}
              className="block w-full rounded-md border-gray-300 text-gray-900 placeholder-gray-400 focus:border-gray-500 focus:outline-none focus:ring-gray-500 sm:text-sm"
              placeholder="A note to partner about this payout. Max 190 characters."
              maxLength={190}
              onKeyDown={handleKeyDown}
            />
          </div>

          {partnerId && Object.entries(invoiceData).length > 0 && (
            <div className="flex flex-col gap-2">
              <p className="text-sm font-medium text-neutral-800">Summary</p>
              <div className="grid grid-cols-2 gap-3 rounded-md border border-neutral-200 bg-neutral-50 p-4 text-sm text-neutral-600">
                {Object.entries(invoiceData).map(([key, value]) => (
                  <Fragment key={key}>
                    <div className="font-medium text-neutral-500">{key}</div>
                    <div className="text-neutral-800">
                      {value as ReactNode | string}
                    </div>
                  </Fragment>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="flex grow flex-col justify-end">
        <div className="flex items-center justify-end gap-2 border-t border-neutral-200 p-5">
          <Button
            type="button"
            variant="secondary"
            onClick={() => setIsOpen(false)}
            text="Cancel"
            className="w-fit"
            disabled={isExecuting}
          />
          <Button
            type="submit"
            variant="primary"
            text="Create payout"
            className="w-fit"
            loading={isExecuting}
            disabled={buttonDisabled}
          />
        </div>
      </div>
    </form>
  );
}

export function CreatePayoutSheet({
  isOpen,
  ...rest
}: CreatePayoutSheetProps & {
  isOpen: boolean;
}) {
  const { queryParams } = useRouterStuff();

  return (
    <Sheet
      open={isOpen}
      onOpenChange={rest.setIsOpen}
      onClose={() => queryParams({ del: "partnerId" })}
    >
      <CreatePayoutSheetContent {...rest} />
    </Sheet>
  );
}

export function useCreatePayoutSheet() {
  const [isOpen, setIsOpen] = useState(false);

  return {
    createPayoutSheet: (
      <CreatePayoutSheet setIsOpen={setIsOpen} isOpen={isOpen} />
    ),
    setIsOpen,
  };
}
