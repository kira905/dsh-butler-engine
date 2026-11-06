// dsh-butler / lib/product.mjs —— 产品版本常量（唯一硬编码点，避免多处漂移）
//
// 为什么单独一个文件：lib/store.mjs 需要 writeJsonAtomic，version.mjs 又需要 store，
// 若版本常量写在 version.mjs 而 store 反向 import 就会成环。常量抽出来最干净。
export const PRODUCT_VERSION = '0.1.0';
