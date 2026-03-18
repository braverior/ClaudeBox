import { create } from "zustand";

export interface Task {
  id: string;
  subject: string;
  description?: string;
  status: "pending" | "in_progress" | "completed";
  /** Which session this task belongs to */
  sessionId: string;
}

interface TaskState {
  tasks: Task[];
  addTask: (task: Task) => void;
  updateTask: (id: string, updates: Partial<Task>) => void;
  removeTask: (id: string) => void;
  clearTasks: (sessionId: string) => void;
  /** Mark all non-completed tasks for a session as completed (called on stream end) */
  markAllCompleted: (sessionId: string) => void;
  /** Parse a tool_use block to extract task operations */
  handleToolUse: (sessionId: string, name: string, input: Record<string, unknown>, result?: string) => void;
}

export const useTaskStore = create<TaskState>((set, get) => ({
  tasks: [],

  addTask: (task) => {
    set({ tasks: [...get().tasks, task] });
  },

  updateTask: (id, updates) => {
    set({
      tasks: get().tasks.map((t) =>
        t.id === id ? { ...t, ...updates } : t
      ),
    });
  },

  removeTask: (id) => {
    set({ tasks: get().tasks.filter((t) => t.id !== id) });
  },

  clearTasks: (sessionId) => {
    set({ tasks: get().tasks.filter((t) => t.sessionId !== sessionId) });
  },

  markAllCompleted: (sessionId) => {
    set({
      tasks: get().tasks.map((t) =>
        t.sessionId === sessionId && t.status !== "completed"
          ? { ...t, status: "completed" }
          : t
      ),
    });
  },

  handleToolUse: (sessionId, name, input, result) => {
    if (name === "TaskCreate" || name === "TodoWrite") {
      // TodoWrite might have a different format
      if (name === "TodoWrite" && Array.isArray(input.todos)) {
        // Replace all tasks for this session
        const todos = input.todos as Array<{ subject?: string; content?: string; status?: string; id?: string }>;
        const newTasks: Task[] = todos.map((t, i) => ({
          id: t.id || `${sessionId}-${i}`,
          subject: t.content || t.subject || `Task ${i + 1}`,
          status: (t.status === "completed" ? "completed" :
                   t.status === "in_progress" ? "in_progress" : "pending") as Task["status"],
          sessionId,
        }));
        set({
          tasks: [
            ...get().tasks.filter((t) => t.sessionId !== sessionId),
            ...newTasks,
          ],
        });
        return;
      }

      // TaskCreate
      const taskId = result?.match(/#(\d+)/)?.[1] || `${Date.now()}`;
      const task: Task = {
        id: taskId,
        subject: (input.subject as string) || "Untitled Task",
        description: input.description as string,
        status: "pending",
        sessionId,
      };
      get().addTask(task);
    }

    if (name === "TaskUpdate") {
      const taskId = input.taskId as string;
      if (taskId) {
        const updates: Partial<Task> = {};
        if (input.status) updates.status = input.status as Task["status"];
        if (input.subject) updates.subject = input.subject as string;
        get().updateTask(taskId, updates);
      }
    }
  },
}));
