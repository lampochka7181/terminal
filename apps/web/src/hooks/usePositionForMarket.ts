import { useQuery } from '@tanstack/react-query';
import { getUserPositionForMarket, type MarketPosition } from '@/lib/api';
import { useUserStore } from '@/stores/userStore';

/**
 * Hook to get the current user's position for a specific market
 */
export function usePositionForMarket(marketAddress: string | undefined) {
  const { isAuthenticated } = useUserStore();
  
  return useQuery<MarketPosition | null>({
    queryKey: ['position', marketAddress],
    queryFn: async () => {
      if (!marketAddress) return null;
      try {
        return await getUserPositionForMarket(marketAddress);
      } catch (error) {
        // Return null if user has no position or is not authenticated
        return null;
      }
    },
    enabled: !!marketAddress && isAuthenticated,
    staleTime: 10000, // 10 seconds
    refetchInterval: 30000, // Refetch every 30 seconds
  });
}

export default usePositionForMarket;

