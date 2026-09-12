import Screen from "./Screen";
import Skeleton from "./Skeleton";

export const LoadingScreen = () => (
  <Screen>
    <div className="grid grid-cols-2 gap-3"><Skeleton className="h-44" /><Skeleton className="h-44" /></div>
    <Skeleton className="h-14" />
    <Skeleton className="h-20" />
    <Skeleton className="h-28" />
  </Screen>
);
export default LoadingScreen;
