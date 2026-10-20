/**
 * 文献页地址。编号放在查询参数里，任何编号都能原样往返：放在路径里时“.”“..”（含 %2E）会被当作
 * 目录规整掉，含点的编号又像静态文件扩展名。passageId 为要定位的片段。
 */
export const documentHref = (id: string, passageId?: string) =>
  `/library/document?${new URLSearchParams({ id })}${passageId ? `#${passageId}` : ''}`
