import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { IratQuestionRequest, IratRequest, LamsConfig } from '../config.js';
import type { QuestionImageAsset } from '../docx/question-images.js';

export interface IratCheckpointQuestion {
  currentUid: string;
  currentLabel: string;
  requestHash: string;
}

export interface IratCheckpointData {
  schemaVersion: 1;
  requestHash: string;
  lesson: {
    workspaceCourse: string;
    folderPath: string[];
    title: string;
  };
  questions: Record<string, IratCheckpointQuestion>;
  iratSaved: boolean;
  updatedAt: string;
}

/**
 * Failure-recovery checkpoint for one exact lesson/request pair. Checkpoints contain no
 * credentials or browser state and live under ignored artifacts/. They are hints only:
 * callers must compare every recorded UID with a fresh live snapshot before skipping.
 */
export class IratCheckpointStore {
  private constructor(
    readonly filePath: string,
    readonly completedPath: string,
    private data: IratCheckpointData
  ) {}

  static async open(
    config: LamsConfig,
    request: IratRequest,
    directory = path.resolve('artifacts', 'irat-checkpoints'),
    questionImages: Map<string, QuestionImageAsset[]> = new Map()
  ): Promise<IratCheckpointStore> {
    const requestHash = hashIratRequest(config, request, questionImages);
    const identity = {
      workspaceCourse: config.workspaceCourse,
      folderPath: [...config.destinationFolderPath],
      title: config.lessonTitle
    };
    await mkdir(directory, { recursive: true });
    const stem = `${safeName(config.lessonTitle)}-${requestHash.slice(0, 16)}`;
    const filePath = path.join(directory, `${stem}.json`);
    const completedPath = path.join(directory, `${stem}-complete-${Date.now()}.json`);
    let data: IratCheckpointData | undefined;
    try {
      data = JSON.parse(await readFile(filePath, 'utf8')) as IratCheckpointData;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (data) validateCheckpoint(data, requestHash, identity);
    return new IratCheckpointStore(filePath, completedPath, data ?? {
      schemaVersion: 1,
      requestHash,
      lesson: identity,
      questions: {},
      iratSaved: false,
      updatedAt: new Date().toISOString()
    });
  }

  get snapshot(): Readonly<IratCheckpointData> {
    return this.data;
  }

  async recordQuestion(question: IratQuestionRequest, currentUid: string, currentLabel: string): Promise<void> {
    this.data.questions[normalise(question.title)] = {
      currentUid,
      currentLabel,
      requestHash: hashIratQuestion(question)
    };
    await this.persist();
  }

  async markIratSaved(): Promise<void> {
    this.data.iratSaved = true;
    await this.persist();
  }

  async complete(): Promise<void> {
    await this.persist();
    await rename(this.filePath, this.completedPath).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      await writeFile(this.completedPath, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
    });
  }

  private async persist(): Promise<void> {
    this.data.updatedAt = new Date().toISOString();
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
    await rename(temporary, this.filePath);
  }
}

export function hashIratQuestion(question: IratQuestionRequest): string {
  return sha256(stableJson(question));
}

export function hashIratRequest(
  config: LamsConfig,
  request: IratRequest,
  questionImages: Map<string, QuestionImageAsset[]> = new Map()
): string {
  return sha256(stableJson({
    workspaceCourse: config.workspaceCourse,
    destinationFolderPath: config.destinationFolderPath,
    lessonTitle: config.lessonTitle,
    request,
    questionImages: [...questionImages.entries()].map(([title, images]) => ({
      title,
      images: images.map(image => ({
        contentHash: sha256(image.data),
        contentType: image.contentType,
        altText: image.altText,
        widthPx: image.widthPx,
        placement: image.placement,
        crop: image.crop,
        caption: image.caption
      }))
    }))
  }));
}

function validateCheckpoint(
  data: IratCheckpointData,
  requestHash: string,
  lesson: IratCheckpointData['lesson']
): void {
  if (data.schemaVersion !== 1 || data.requestHash !== requestHash || stableJson(data.lesson) !== stableJson(lesson)) {
    throw new Error('The iRAT checkpoint does not belong to this exact lesson and resolved request.');
  }
  if (!data.questions || typeof data.questions !== 'object' || Array.isArray(data.questions)) {
    throw new Error('The iRAT checkpoint question map is invalid.');
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function safeName(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'lesson';
}

function normalise(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
