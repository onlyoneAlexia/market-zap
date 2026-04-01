import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

const ENV_OPERATOR = process.env.NEXT_PUBLIC_ADMIN_ADDRESS?.toLowerCase();

function normalize(addr: string): string {
  return "0x" + addr.replace(/^0x0*/i, "").toLowerCase();
}

/**
 * Returns the normalised operator address.
 * Prefers the build-time env var; falls back to the engine `/api/config` endpoint.
 */
function useOperatorAddress(): string | undefined {
  const { data } = useQuery({
    queryKey: ["engine-config"],
    queryFn: () => api.getConfig(),
    staleTime: Infinity,
    gcTime: Infinity,
    enabled: !ENV_OPERATOR,
  });

  const raw = ENV_OPERATOR || data?.operatorAddress;
  return raw ? normalize(raw) : undefined;
}

/**
 * Returns true when the connected wallet is the protocol operator.
 */
export function useIsOperator(address: string | undefined): boolean {
  const operatorAddress = useOperatorAddress();
  if (!address || !operatorAddress) return false;
  return normalize(address) === operatorAddress;
}
