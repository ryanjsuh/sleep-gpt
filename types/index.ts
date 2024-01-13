export type PGEssay = {
  title: string;
  url: string;
  date: string;
  authors: string;
  content: string;
  tokens: number;
  chunks: PGChunk[];
}

export type PGChunk = {
  essay_title: string;
  essay_url: string;
  essay_date: string;
  essay_authors: string,
  content: string;
  content_tokens: number;
  embedding: number[];

}

export type PGJSON = {
  tokens: number;
  essays: PGEssay[];
};