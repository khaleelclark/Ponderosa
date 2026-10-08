/** Common collection fields; HTTP endpoints retain their array/header transport. */
export interface CollectionPageDto<T> {
  items: T[];
  total: number;
  limit: number;
  hasMore: boolean;
  cursor?: string;
}
