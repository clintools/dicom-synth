import dcmjsDefaultImport, * as dcmjsNamespace from 'dcmjs'

type DcmjsModule = typeof dcmjsNamespace

/** Resolve dcmjs across ESM namespace vs default export interop. */
export function loadDcmjs(): DcmjsModule {
  if (dcmjsNamespace.data?.DicomDict) {
    return dcmjsNamespace
  }
  const d = dcmjsDefaultImport as DcmjsModule & { default?: DcmjsModule }
  if (d?.data?.DicomDict) {
    return d
  }
  if (d?.default?.data?.DicomDict) {
    return d.default
  }
  throw new Error(
    'dcmjs failed to load (missing data.DicomDict). Install dcmjs >= 0.29.',
  )
}

export const dcmjs = loadDcmjs()
