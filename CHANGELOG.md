# [1.15.0](https://github.com/clintools/dicom-synth/compare/v1.14.0...v1.15.0) (2026-07-10)


### Features

* add generic directory-tree structure and sized non-DICOM files ([b47be25](https://github.com/clintools/dicom-synth/commit/b47be25a9b74efbf4c13e7cff3321980ead2b00f))

# [1.14.0](https://github.com/clintools/dicom-synth/compare/v1.13.0...v1.14.0) (2026-07-09)


### Features

* preserve UID references nested in sequences on describe ([e5c8972](https://github.com/clintools/dicom-synth/commit/e5c8972b201f91b4cea28a9e392b3d6257ae2ac4))

# [1.13.0](https://github.com/clintools/dicom-synth/compare/v1.12.0...v1.13.0) (2026-07-06)


### Features

* preserve cross-file UID links in describe (on by default) ([687ca5c](https://github.com/clintools/dicom-synth/commit/687ca5c6d7f9ab2dafc802daa996488ce119d1b6))

# [1.12.0](https://github.com/clintools/dicom-synth/compare/v1.11.0...v1.12.0) (2026-07-03)


### Features

* hash-derived UIDs with a dataset salt ([dedc89f](https://github.com/clintools/dicom-synth/commit/dedc89f9cfcbf40a37f495d47bff5897c2c40921))

# [1.11.0](https://github.com/clintools/dicom-synth/compare/v1.10.0...v1.11.0) (2026-06-30)


### Features

* per-instance tag grouping, size-collapse tolerance, and gzip for describe ([7643b81](https://github.com/clintools/dicom-synth/commit/7643b81a43fbe49b9a7825df15563a16d32d95e6))

# [1.10.0](https://github.com/clintools/dicom-synth/compare/v1.9.0...v1.10.0) (2026-06-29)


### Features

* add --keep-tags-file to read the describe keep-list from a file ([3d5d87a](https://github.com/clintools/dicom-synth/commit/3d5d87af79777388e72f982827bedae28838ecad))
* templated tag values and Modality coupling guard across all paths ([256f0fd](https://github.com/clintools/dicom-synth/commit/256f0fd02ef1c54ac505bcd0524b1066f48aa038))

# [1.9.0](https://github.com/clintools/dicom-synth/compare/v1.8.0...v1.9.0) (2026-06-24)


### Features

* **describe:** capture large files header-only ([6cb8cbc](https://github.com/clintools/dicom-synth/commit/6cb8cbc1d609be49bcbdf91580ced38f19b06890))
* generate large DICOM files (streaming writer + dataset entry) ([2817e3a](https://github.com/clintools/dicom-synth/commit/2817e3acb56267d23897af0d1018417e4d753371))
* **parametric:** add large-file support ([4774708](https://github.com/clintools/dicom-synth/commit/4774708b278409615e5bff84f7c5c8086f1a4555))

# [1.8.0](https://github.com/clintools/dicom-synth/compare/v1.7.0...v1.8.0) (2026-06-22)


### Features

* capture a drawn seed on the plain generate path ([66b6283](https://github.com/clintools/dicom-synth/commit/66b6283e20dc29a7ed1f281b565a4d473bab72c4))

# [1.7.0](https://github.com/clintools/dicom-synth/compare/v1.6.0...v1.7.0) (2026-06-15)


### Features

* add pathQuirks for edge-case file/directory names ([0ea4871](https://github.com/clintools/dicom-synth/commit/0ea4871071c48faf92f616d69d3a6dd0de809f82))

# [1.6.0](https://github.com/clintools/dicom-synth/compare/v1.5.0...v1.6.0) (2026-06-14)


### Features

* add describe tool — DICOM tree to DatasetSpec ([94bf455](https://github.com/clintools/dicom-synth/commit/94bf4550ab35c2525ec460d9948999dce70e70ac))

# [1.5.0](https://github.com/clintools/dicom-synth/compare/v1.4.0...v1.5.0) (2026-06-13)


### Features

* add ParametricSpec, resolver, and CLI flags ([4f1e1e5](https://github.com/clintools/dicom-synth/commit/4f1e1e50646904360f2d37f349f65fd46b1d2943))

# [1.4.0](https://github.com/clintools/dicom-synth/compare/v1.3.0...v1.4.0) (2026-06-12)


### Features

* add targetSizeKb size targeting and fold large-image into base image sizing ([ab0bd38](https://github.com/clintools/dicom-synth/commit/ab0bd3815dbaaf7ff99ea1ba1ec08ad07c361523))

# [1.3.0](https://github.com/clintools/dicom-synth/compare/v1.2.0...v1.3.0) (2026-06-12)


### Features

* add modality presets and rename image spec types from *-ct to *-image ([053fde0](https://github.com/clintools/dicom-synth/commit/053fde045cdaf36c1e7548051853bd08f0540720))

# [1.2.0](https://github.com/clintools/dicom-synth/compare/v1.1.0...v1.2.0) (2026-06-12)


### Features

* add study/series grouping, hierarchical layout, and InstanceNumber sequencing ([316eb5c](https://github.com/clintools/dicom-synth/commit/316eb5c759006e5b96c80772fcfa1f519df36152))

# [1.1.0](https://github.com/clintools/dicom-synth/compare/v1.0.1...v1.1.0) (2026-06-11)


### Features

* replace fixed fixture catalogue with schema-driven dataset generation ([d5c5911](https://github.com/clintools/dicom-synth/commit/d5c591187e3770f8c921c97d90f20157854976e9))

## [1.0.1](https://github.com/clintools/dicom-synth/compare/v1.0.0...v1.0.1) (2026-06-03)


### Bug Fixes

* grant pull-requests and issues write permissions release workflow whilst repo is private ([39f9230](https://github.com/clintools/dicom-synth/commit/39f9230f4af2393a97e279fcd8e7321e393feef7))

# 1.0.0 (2026-06-03)


### Bug Fixes

* resolve dcmjs ESM interop for synthetic fixture generation ([41d0d8b](https://github.com/clintools/dicom-synth/commit/41d0d8b0efea7433097b2b8cfffcf5facc1532d7))


### Features

* add basic synthetic dicom generator for initial, limited cases ([e46dee9](https://github.com/clintools/dicom-synth/commit/e46dee9694c7673d167fec4aa173e3947d8327ab))
* migrate writeMinimalDicomFile and negative-case writers from dicom-curate ([766d6df](https://github.com/clintools/dicom-synth/commit/766d6df80c134249e35e2e898e6afcb69014f7aa))
* **public-fixtures:** add catalog-backed fetch/cache with sha256 verification ([274463b](https://github.com/clintools/dicom-synth/commit/274463bf3ff33f89c71daccf723d054ebfd3dc30))
