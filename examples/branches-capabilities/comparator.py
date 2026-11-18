"""Matched research/critique/review source. Importing performs no model calls.

Caller supplies two configured chat models and a real evidence search callback.
In-memory persistence is demonstration storage; no restart durability claim.
"""
from typing import TypedDict
from langchain.agents import create_agent
from langchain.tools import tool
from langgraph.graph import StateGraph, START, END
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.store.memory import InMemoryStore
from langgraph.types import interrupt, Command


class State(TypedDict, total=False):
    question: str
    research: str
    critique: str
    answer: str
    approved: bool


def create_review_application(research_model, critic_model, search_evidence):
    memory = InMemoryStore()

    @tool
    def evidence_search(query: str) -> str:
        """Search caller-authorized evidence and return attributed text."""
        return search_evidence(query)

    researcher = create_agent(research_model, tools=[evidence_search])
    critic = create_agent(critic_model, tools=[evidence_search])

    def research(state: State):
        remembered = memory.get(("review",), state["question"])
        context = remembered.value["answer"] if remembered else "No retained answer."
        result = researcher.invoke({"messages": [{"role": "user", "content":
            f'Research with sources: {state["question"]}\nPrevious review: {context}'}]})
        return {"research": result["messages"][-1].content}

    child = StateGraph(State)
    child.add_node("research", research)
    child.add_edge(START, "research")
    child.add_edge("research", END)

    def critique(state: State):
        result = critic.invoke({"messages": [{"role": "user", "content":
            f'Independently identify assumptions and risks: {state["question"]}'}]})
        return {"critique": result["messages"][-1].content}

    def review(state: State):
        # Resume supplies an explicit decision and optional edited answer.
        choice = interrupt({"question": state["question"],
                            "results": [state["research"], state["critique"]]})
        if not isinstance(choice, dict) or choice.get("decision") not in ("approve", "reject"):
            raise ValueError("Explicit approve/reject required")
        answer = choice.get("answer", state["research"])
        if not isinstance(answer, str):
            raise ValueError("Edited answer must be text")
        if choice["decision"] == "reject":
            return {"answer": "Rejected", "approved": False}
        return {"answer": answer, "approved": True}

    def remember(state: State):
        # Store only after the interrupt node has completed; interrupt restarts its node.
        if state["approved"]:
            memory.put(("review",), state["question"], {"answer": state["answer"]})
        return {}

    parent = StateGraph(State)
    parent.add_node("research", child.compile())
    parent.add_node("critique", critique)
    parent.add_node("review", review)
    parent.add_node("remember", remember)
    parent.add_edge(START, "research")
    parent.add_edge(START, "critique")
    parent.add_edge(["research", "critique"], "review")
    parent.add_edge("review", "remember")
    parent.add_edge("remember", END)
    return parent.compile(checkpointer=InMemorySaver(), store=memory)


def start(graph, question: str, thread_id: str):
    return graph.stream({"question": question},
                        {"configurable": {"thread_id": thread_id}}, stream_mode="updates")


def resume(graph, thread_id: str, decision: str, answer: str):
    return graph.stream(Command(resume={"decision": decision, "answer": answer}),
                        {"configurable": {"thread_id": thread_id}}, stream_mode="updates")


def checkpoints(graph, thread_id: str):
    return graph.get_state_history({"configurable": {"thread_id": thread_id}})


def rewind(graph, checkpoint_config):
    # Explicit caller-selected historical config; may repeat model/tool work.
    return graph.stream(None, checkpoint_config, stream_mode="updates")
