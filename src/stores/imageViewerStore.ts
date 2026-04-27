import { create } from "zustand";

interface ImageViewerState {
  open: boolean;
  src: string | null;
  name?: string;
  path?: string;
  openImage: (src: string, name?: string, path?: string) => void;
  closeImage: () => void;
}

export const useImageViewerStore = create<ImageViewerState>((set) => ({
  open: false,
  src: null,
  name: undefined,
  path: undefined,
  openImage: (src, name, path) => set({ open: true, src, name, path }),
  closeImage: () => set({ open: false, src: null, name: undefined, path: undefined }),
}));
