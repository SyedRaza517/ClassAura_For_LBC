import Card from "./Card";

export const ErrBox = ({ children }) => <Card className="!bg-rose-50 !ring-rose-200 text-sm font-semibold text-rose-600 dark:!bg-rose-950/40 dark:!ring-rose-900 dark:text-rose-300">{children}</Card>;
export default ErrBox;
