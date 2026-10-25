/**
 * 测试环境补齐。
 *
 * jsdom 的 `File` 没有实现 `arrayBuffer()`（浏览器有）。上传准备依赖它读字节，
 * 因此在这里用 `FileReader` 补一个等价实现——**只补测试环境**，
 * 生产代码不因此多一条分支（浏览器路径不需要兼容层）。
 */

const FileCtor = globalThis.File

if (typeof FileCtor !== 'undefined' && typeof FileCtor.prototype.arrayBuffer !== 'function') {
  Object.defineProperty(FileCtor.prototype, 'arrayBuffer', {
    configurable: true,
    writable: true,
    value: function arrayBuffer(this: File): Promise<ArrayBuffer> {
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => {
          const result = reader.result
          if (result instanceof ArrayBuffer) resolve(result)
          else reject(new Error('FileReader 未返回 ArrayBuffer'))
        }
        reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'))
        reader.readAsArrayBuffer(this)
      })
    },
  })
}
