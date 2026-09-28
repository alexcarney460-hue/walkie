import { useEffect } from "react";
import { useRoute } from "../../lib/route.ts";
import { projectsStore } from "../../state/projects.ts";
import { ProjectBoard } from "./ProjectBoard.tsx";
import { ProjectList } from "./ProjectList.tsx";

/** #/projects (the list by folder), #/projects/<channel>[/<board>]?card=<id> (a board), #/projects/<channel>/room (its Data Room). */
export function Projects() {
  const route = useRoute();
  useEffect(() => { void projectsStore.refresh(); }, []);
  return route.channel ? <ProjectBoard channel={route.channel} boardId={route.board} cardId={route.card} room={route.room === true} /> : <ProjectList />;
}
