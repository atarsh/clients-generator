import { KalturaUploadRequest } from "../api/kaltura-upload-request";
import { createEndpoint, prepareParameters } from "./utils";
import { KalturaClientException } from "../api/kaltura-client-exception";
import { KalturaRequestOptions } from "../api/kaltura-request-options";
import { KalturaClientOptions } from "../kaltura-client-options";
import { KalturaAPIException } from "../api/kaltura-api-exception";
import { CancelableAction } from "../cancelable-action";
import { KalturaUploadConnectionsManager } from "./kaltura-upload-connections-manager";

interface UploadBySequentialChunksData {
    enabled: boolean;
    resume: boolean;
    resumeAt: number;
    finalChunk: boolean;
}

interface UploadByParallelChunksData {
    chunkUploadEnabled: boolean;

    /**
     * bytes uploaded so far
     */
    loaded: number;

    /**
     * total number of chunks in the current file
     */
    totalChunks: number;

    /**
     * number of bytes per chunk
     */
    chunkSize: number;

    /**
     * number of chunks done uploading
     */
    chunksUploaded: number;

    /**
     * number of the next chunk to start uploading
     */
    nextChunkIndex: number;
}

export class KalturaUploadRequestAdapter {

    private _chunkUploadSupported(request: KalturaUploadRequest<any>): boolean {
        // SUPPORTED BY BROWSER?
        // Check if these features are support by the browser:
        // - File object type
        // - Blob object type
        // - FileList object type
        // - slicing files
        const supportedByBrowser = (
            (typeof(File) !== "undefined")
            &&
            (typeof(Blob) !== "undefined")
            &&
            (typeof(FileList) !== "undefined")
            &&
            (!!(<any>Blob.prototype)["webkitSlice"] || !!(<any>Blob.prototype)["mozSlice"] || !!(<any>Blob.prototype).slice || false)
        );
        const supportedByRequest = request.supportChunkUpload();
        const enabledInClient = !this.clientOptions.chunkFileDisabled;

        return enabledInClient && supportedByBrowser && supportedByRequest;
    }

    constructor(public clientOptions: KalturaClientOptions, public defaultRequestOptions: KalturaRequestOptions) {
        if (clientOptions.parallelUploadsDisabled) {
            return;
        }
        if (KalturaUploadConnectionsManager.getTotalConnections() === -1) {
            // initialize manager
            KalturaUploadConnectionsManager.setTotalConnections(clientOptions.maxConcurrentUploadConnections || 6);
        }
    }

    transmit(request: KalturaUploadRequest<any>): CancelableAction<any> {
        if (this.clientOptions.parallelUploadsDisabled) {
            return this.transmit_sequential(request);
        }
        return this.transmit_parallel(request);
    }

    transmit_sequential(request: KalturaUploadRequest<any>): CancelableAction<any> {
        return new CancelableAction((resolve, reject, action) => {
            const uploadedFileSize = !isNaN(request.uploadedFileSize) && isFinite(request.uploadedFileSize) && request.uploadedFileSize > 0 ? request.uploadedFileSize : 0;
            const data: UploadBySequentialChunksData = {
                enabled: this._chunkUploadSupported(request),
                resume: !!uploadedFileSize,
                finalChunk: false,
                resumeAt: uploadedFileSize,
            };

            let activeAction: CancelableAction<any>;

            const handleChunkUploadError = reason => {
                activeAction = null;
                reject(reason);
            };

            const handleChunkUploadSuccess = result => {
                if (!data.enabled || data.finalChunk) {
                    activeAction = null;
                    this._handleFinalChunkResponse(request, result, reject, resolve);

                } else {
                    activeAction = this._chunkUpload(request, data).then(handleChunkUploadSuccess, handleChunkUploadError);
                }
            };

            activeAction = this._chunkUpload(request, data)
                .then(handleChunkUploadSuccess, handleChunkUploadError);


            return () => {
                if (activeAction) {
                    activeAction.cancel();
                    activeAction = null;
                }
            };
        });
    }

    transmit_parallel(request: KalturaUploadRequest<any>): CancelableAction<any> {
        return new CancelableAction((resolve, reject, action) => {
            const { file} = request.getFileInfo();
            const chunkSize = this._getChunkSize();

            const data: UploadByParallelChunksData = {
                chunkUploadEnabled: this._chunkUploadSupported(request),
                loaded: 0,
                totalChunks: Math.ceil(file.size / chunkSize),
                chunkSize: chunkSize,
                chunksUploaded: 0,
                nextChunkIndex: 0,
            };

            let activeAction: CancelableAction<any>;

            const tryUpload = (waitIfNoConnections = true) => {
                if (KalturaUploadConnectionsManager.retrieveConnection()) {
                    console.log("tryUpload - got connection");
                    activeAction = this._uploadChunk(request, data, data.nextChunkIndex)
                        .then(handleChunkUploadSuccess, handleChunkUploadError);
                    data.nextChunkIndex += 1;
                    return true;
                }
                else if (waitIfNoConnections) {
                    console.log("tryUpload - no connections, waiting");
                    KalturaUploadConnectionsManager.addAvailableConnectionsCallback(waitForConnection);
                }
                return false;
            };

            const handleChunkUploadError = reason => {
                activeAction = null;
                reject(reason);
            };

            const handleChunkUploadSuccess = result => {
                console.log("handleChunkUploadSuccess");
                // "clean up":
                activeAction = null;
                data.chunksUploaded += 1;
                KalturaUploadConnectionsManager.releaseConnection();

                // was this the final chunk?
                const { file} = request.getFileInfo();
                const chunkSize = this._getChunkSize();
                const totalChunks = Math.ceil(file.size / chunkSize);
                const finalChunk = data.chunksUploaded >= totalChunks;
                const hasMoreChunks = data.nextChunkIndex < totalChunks;

                if (!data.chunkUploadEnabled || finalChunk) {
                    this._handleFinalChunkResponse(request, result, reject, resolve);
                }
                else if (hasMoreChunks) {
                    tryUpload();
                }
            };

            const waitForConnection = () => {
                if (KalturaUploadConnectionsManager.retrieveConnection()) {
                    activeAction = this._uploadChunk(request, data, data.nextChunkIndex)
                        .then(handleChunkUploadSuccess, handleChunkUploadError);
                    data.nextChunkIndex += 1;
                }
            };

            while (true) {
                if (data.nextChunkIndex >= data.totalChunks || !tryUpload(false)) {
                    break;
                }
                // add as many chunks as possible
                console.log("chunk added");
            }

            return () => {
                if (activeAction) {
                    activeAction.cancel();
                    activeAction = null;
                }
            };
        });
    }

    private _handleFinalChunkResponse(request: KalturaUploadRequest<any>, result, reject: (reason: Error) => any, resolve: (value: any) => any) {
        console.log("_handleFinalChunkResponse");
        try {
            const response = request.handleResponse(result);

            if (response.error) {
                reject(response.error);
            } else {
                resolve(response.result);
            }
        } catch (error) {
            if (error instanceof KalturaClientException || error instanceof KalturaAPIException) {
                reject(error);
            } else {
                const errorMessage = error instanceof Error ? error.message : typeof error === "string" ? error : null;
                reject(new KalturaClientException("client::response-unknown-error", errorMessage || "Failed to parse response"));
            }
        }
    }

    private _getFormData(filePropertyName: string, fileName: string, fileChunk: File | Blob): FormData {
        const result = new FormData();
        result.append("fileName", fileName);
        result.append(filePropertyName, fileChunk);
        return result;
    }

    /**
     * chunk upload for sequential chunks upload
     * @param request
     * @param uploadChunkData
     * @private
     */
    private _chunkUpload(request: KalturaUploadRequest<any>, uploadChunkData: UploadBySequentialChunksData): CancelableAction<any> {
        return new CancelableAction((resolve, reject) => {
            const parameters = prepareParameters(request, this.clientOptions, this.defaultRequestOptions);

            let isComplete = false;
            const {propertyName, file} = request.getFileInfo();
            let data = this._getFormData(propertyName, file.name, file);

            let fileStart = 0;

            if (uploadChunkData.enabled) {
                let actualChunkFileSize: number = this._getChunkSize();

                uploadChunkData.finalChunk = (file.size - uploadChunkData.resumeAt) <= actualChunkFileSize;

                fileStart = uploadChunkData.resumeAt;
                const fileEnd = uploadChunkData.finalChunk ? file.size : fileStart + actualChunkFileSize;

                data = this._getFormData(propertyName, file.name, file.slice(fileStart, fileEnd, file.type));

                parameters.resume = uploadChunkData.resume;
                parameters.resumeAt = uploadChunkData.resumeAt;
                parameters.finalChunk = uploadChunkData.finalChunk;
            } else {
                console.log(`chunk upload not supported by browser or by request. Uploading the file as-is`);
            }

            // const { service, action, ks, ...queryparams } = parameters;
            const {service, action, ...queryparams} = parameters;
            const endpointUrl = createEndpoint(request, this.clientOptions, service, action, queryparams);

            // TODO should uncomment this part and verify that upload sends the ks as part of the body and not in the query param. see https://kaltura.atlassian.net/browse/KMCNG-2401
            // data.append('ks', ks);

            const xhr = new XMLHttpRequest();

            xhr.onreadystatechange = () => {
                if (xhr.readyState === 4) {
                    if (isComplete) {
                        return;
                    }
                    isComplete = true;
                    let resp;

                    try {
                        if (xhr.status === 200) {
                            resp = JSON.parse(xhr.response);
                        } else {
                            resp = new KalturaClientException("client::upload-failure", xhr.responseText || "failed to upload file");
                        }
                    } catch (e) {
                        resp = new KalturaClientException("client::upload-failure", e.message || "failed to upload file");
                    }

                    if (resp instanceof Error) {
                        reject(resp);
                    } else {
                        if (uploadChunkData.enabled) {
                            if (typeof resp.uploadedFileSize === "undefined" || resp.uploadedFileSize === null) {
                                reject(new KalturaClientException("client::upload-failure", `uploaded chunk of file failed, expected response with property 'uploadedFileSize'`));
                                return;
                            } else if (!uploadChunkData.finalChunk) {
                                uploadChunkData.resumeAt = Number(resp.uploadedFileSize);
                                uploadChunkData.resume = true;
                            }
                        }

                        resolve(resp);
                    }
                }
            };

            const progressCallback = request._getProgressCallback();
            if (progressCallback) {
                xhr.upload.addEventListener("progress", e => {
                    if (e.lengthComputable) {
                        progressCallback.apply(request, [e.loaded + fileStart, file.size]);
                    } else {
                        // Unable to compute progress information since the total size is unknown
                    }
                }, false);
            }

            xhr.open("POST", endpointUrl);
            xhr.send(data);

            return () => {
                if (!isComplete) {
                    isComplete = true;
                    xhr.abort();
                }
            };
        });
    }

    /**
     * chunk upload for parallel chunks upload
     * @param request
     * @param uploadChunkData
     * @param chunkIndex
     * @private
     */
    private _uploadChunk(request: KalturaUploadRequest<any>, uploadChunkData: UploadByParallelChunksData, chunkIndex: number): CancelableAction<any> {
        console.log("_uploadChunk, chunkIndex ", chunkIndex);
        return new CancelableAction((resolve, reject) => {
            const parameters = prepareParameters(request, this.clientOptions, this.defaultRequestOptions);

            let isComplete = false;
            const {propertyName, file} = request.getFileInfo();
            let data = this._getFormData(propertyName, file.name, file);

            let fileStart = 0;

            if (uploadChunkData.chunkUploadEnabled) {
                const chunkSize = uploadChunkData.chunkSize;
                const resumeAt = chunkIndex * chunkSize;
                const finalChunk = (file.size - resumeAt) <= chunkSize;

                fileStart = resumeAt;
                const fileEnd = finalChunk ? file.size : fileStart + chunkSize;

                data = this._getFormData(propertyName, file.name, file.slice(fileStart, fileEnd, file.type));

                parameters.resume = chunkIndex > 0;
                parameters.resumeAt = resumeAt;
                parameters.finalChunk = finalChunk;
            } else {
                console.log(`chunk upload not supported by browser or by request. Uploading the file as-is`);
            }

            // const { service, action, ks, ...queryparams } = parameters;
            const {service, action, ...queryparams} = parameters;
            const endpointUrl = createEndpoint(request, this.clientOptions, service, action, queryparams);

            const xhr = new XMLHttpRequest();

            xhr.onreadystatechange = () => {
                if (xhr.readyState === 4) {
                    if (isComplete) {
                        return;
                    }
                    isComplete = true;
                    let resp;

                    try {
                        if (xhr.status === 200) {
                            resp = JSON.parse(xhr.response);
                        } else {
                            resp = new KalturaClientException("client::upload-failure", xhr.responseText || "failed to upload file");
                        }
                    } catch (e) {
                        resp = new KalturaClientException("client::upload-failure", e.message || "failed to upload file");
                    }

                    if (resp instanceof Error) {
                        reject(resp);
                    } else {
                        if (uploadChunkData.chunkUploadEnabled) {
                            if (typeof resp.uploadedFileSize === "undefined" || resp.uploadedFileSize === null) {
                                reject(new KalturaClientException("client::upload-failure", `uploaded chunk of file failed, expected response with property 'uploadedFileSize'`));
                                return;
                            }
                        }

                        resolve(resp);
                    }
                }
            };

            // const progressCallback = request._getProgressCallback();
            // if (progressCallback) {
            //     xhr.upload.addEventListener("progress", e => {
            //         if (e.lengthComputable) {
            //             progressCallback.apply(request, [e.loaded + fileStart, file.size]);
            //         } else {
            //             // Unable to compute progress information since the total size is unknown
            //         }
            //     }, false);
            // }

            xhr.open("POST", endpointUrl);
            xhr.send(data);

            return () => {
                if (!isComplete) {
                    isComplete = true;
                    xhr.abort();
                }
            };
        });
    }

    private _getChunkSize() {
        const userChunkFileSize = this.clientOptions ? this.clientOptions.chunkFileSize : null;

        if (userChunkFileSize && Number.isFinite(userChunkFileSize) && !Number.isNaN(userChunkFileSize)) {
            if (userChunkFileSize < 1e5) {
                console.warn(`user requested for invalid upload chunk size '${userChunkFileSize}'. minimal value 100Kb. using minimal value 100Kb instead`);
                return 1e5;
            } else {
                console.log(`using user requested chunk size '${userChunkFileSize}'`);
                return userChunkFileSize;
            }
        } else {
            console.log(`using default chunk size 5Mb`);
            return 5e6; // default
        }
    }
}
