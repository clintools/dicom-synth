declare module 'dcmjs' {
  export namespace data {
    class DicomDict {
      meta: DicomDataset
      dict: DicomDataset
      constructor(meta: DicomDataset)
      write(options?: { allowInvalidVRLength?: boolean }): ArrayBuffer
    }
    type DicomDataset = Record<string, unknown>
    namespace DicomMetaDictionary {
      function denaturalizeDataset(
        dataset: Record<string, unknown>,
      ): DicomDataset
    }
  }
}
