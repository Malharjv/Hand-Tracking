/**
 * Conversation Tree Chatbot with React Flow
 * 
 * Each node contains both prompt and response.
 * Editing prompts creates new branches.
 * Sending new prompts creates connected nodes.
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  Node,
  Edge,
  NodeChange,
  EdgeChange,
  applyNodeChanges,
  applyEdgeChanges,
  MarkerType,
  Position,
  NodeProps,
  Handle,
  ReactFlowInstance,
} from 'reactflow';
import 'reactflow/dist/style.css';
import './custom_scrollbar.css';

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

interface ConversationNode {
  id: string;
  parentId: string | null;
  prompt: string;
  response: string;
  timestamp: Date;
  branchLabel?: string;
}

interface TreeData {
  nodes: ConversationNode[];
  activeNodeId: string | null;
}

// ============================================================================
// STABLE LAYOUT SYSTEM
// ============================================================================

const nodeWidth = 380;
const nodeHeight = 140;
const verticalSpacing = 180;
const horizontalSpacing = 450;
const minHorizontalGap = 50; // Minimum gap between nodes

// Persistent position cache - nodes keep their positions once set
const lockedPositions = new Map<string, { x: number; y: number }>();

// Check if two nodes would overlap
function wouldOverlap(pos1: { x: number; y: number }, pos2: { x: number; y: number }): boolean {
  const horizontalOverlap = Math.abs(pos1.x - pos2.x) < (nodeWidth + minHorizontalGap);
  const verticalOverlap = Math.abs(pos1.y - pos2.y) < (nodeHeight + 20);
  return horizontalOverlap && verticalOverlap;
}

// Get all descendant node IDs for a given node
function getAllDescendants(nodeId: string, allNodes: ConversationNode[]): string[] {
  const descendants: string[] = [];
  const children = allNodes.filter(n => n.parentId === nodeId);
  
  children.forEach(child => {
    descendants.push(child.id);
    // Recursively get descendants of this child
    descendants.push(...getAllDescendants(child.id, allNodes));
  });
  
  return descendants;
}

// Shift a node and its entire branch to the right
function shiftBranchRight(nodeId: string, shiftAmount: number, allNodes: ConversationNode[]): void {
  // Get the node and all its descendants
  const nodesToShift = [nodeId, ...getAllDescendants(nodeId, allNodes)];
  
  // Shift all nodes in the branch
  nodesToShift.forEach(id => {
    const pos = lockedPositions.get(id);
    if (pos) {
      pos.x += shiftAmount;
    }
  });
}

// Shift nodes to the right to make space (moves entire branches)
function shiftNodesRight(fromX: number, atY: number, shiftAmount: number, exceptNodeId: string, allNodes: ConversationNode[]): void {
  // Find nodes at the same level that need to be shifted
  const nodesToCheck = Array.from(lockedPositions.entries())
    .filter(([nodeId, pos]) => 
      nodeId !== exceptNodeId && 
      pos.x >= fromX && 
      Math.abs(pos.y - atY) < nodeHeight + 20
    );
  
  // Shift each node and its entire branch
  nodesToCheck.forEach(([nodeId]) => {
    shiftBranchRight(nodeId, shiftAmount, allNodes);
  });
}

// Get the rightmost X position among all descendants of a node
function getRightmostDescendantX(nodeId: string, allNodes: ConversationNode[]): number {
  const descendants = getAllDescendants(nodeId, allNodes);
  let rightmostX = lockedPositions.get(nodeId)?.x ?? 0;
  
  descendants.forEach(descId => {
    const pos = lockedPositions.get(descId);
    if (pos && pos.x > rightmostX) {
      rightmostX = pos.x;
    }
  });
  
  return rightmostX;
}

// Shift all ancestor siblings (parent, grandparent, etc.) to the right
// Only shifts siblings that are to the right of the branching parent
function shiftAllAncestorSiblings(nodeId: string, allNodes: ConversationNode[]): void {
  const node = allNodes.find(n => n.id === nodeId);
  if (!node || !node.parentId) return;
  
  // Get the parent's x position to determine which siblings to shift
  const parent = allNodes.find(n => n.id === node.parentId);
  if (!parent) return;
  
  const parentPos = lockedPositions.get(parent.id);
  if (!parentPos) return;
  
  let currentNode = node;
  
  // Walk up the tree and shift siblings at each level
  while (currentNode.parentId) {
    const ancestor = allNodes.find(n => n.id === currentNode.parentId);
    if (!ancestor) break;
    
    // Find all siblings of the ancestor (aunts/uncles of original node)
    const ancestorSiblings = allNodes.filter(n => 
      n.parentId === ancestor.parentId && n.id !== ancestor.id
    );
    
    // Only shift siblings that are to the RIGHT of the branching parent
    ancestorSiblings.forEach(sibling => {
      const siblingPos = lockedPositions.get(sibling.id);
      if (siblingPos && siblingPos.x > parentPos.x) {
        shiftBranchRight(sibling.id, horizontalSpacing, allNodes);
      }
    });
    
    // Move up to the next level
    currentNode = ancestor;
  }
}

function layoutNodes(treeData: TreeData): { nodes: Node[]; edges: Edge[] } {
  // Sort nodes by timestamp to maintain creation order
  const sortedNodes = [...treeData.nodes].sort((a, b) => 
    new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  // Build edges from parent relationships
  const edges: Edge[] = [];
  sortedNodes.forEach((node) => {
    if (node.parentId) {
      edges.push({
        id: `${node.parentId}-${node.id}`,
        source: node.parentId,
        target: node.id,
        type: 'smoothstep',
        animated: treeData.activeNodeId === node.id,
        markerEnd: { type: MarkerType.ArrowClosed },
        style: {
          strokeWidth: 2,
          stroke: treeData.activeNodeId === node.id ? '#3b82f6' : '#94a3b8',
        },
      });
    }
  });

  // Calculate positions - parent positions are locked once set
  sortedNodes.forEach((node) => {
    if (!lockedPositions.has(node.id)) {
      if (!node.parentId) {
        // Root node at origin
        lockedPositions.set(node.id, { x: 0, y: 0 });
      } else {
        const parentPos = lockedPositions.get(node.parentId);
        if (parentPos) {
          // Get all siblings (same parent)
          const siblings = sortedNodes.filter(n => n.parentId === node.parentId);
          const siblingIndex = siblings.findIndex(n => n.id === node.id);
          
          // Calculate desired position
          let desiredPos: { x: number; y: number };
          
          if (siblingIndex === 0) {
            // First child - continuing the conversation stream downwards
            desiredPos = {
              x: parentPos.x,
              y: parentPos.y + verticalSpacing,
            };
            
            // When continuing downwards (not branching), shift ANY nodes that would overlap
            // This ensures the conversation stream grows downwards and pushes branches right
            let hasOverlap = true;
            let maxIterations = 50; // Prevent infinite loops
            let iterations = 0;
            
            while (hasOverlap && iterations < maxIterations) {
              hasOverlap = false;
              iterations++;
              
              // Check against ALL existing locked positions
              for (const [existingNodeId, existingPos] of lockedPositions.entries()) {
                if (existingNodeId !== node.id && wouldOverlap(desiredPos, existingPos)) {
                  // Shift existing node and its entire branch to the right
                  shiftBranchRight(existingNodeId, horizontalSpacing, sortedNodes);
                  hasOverlap = true;
                  // Don't break - continue checking in case we need to shift multiple branches
                }
              }
            }
          } else {
            // Additional children - creating a branch to the right
            // To avoid line intersections, position branch to the right of all downstream nodes
            const parent = sortedNodes.find(n => n.id === node.parentId);
            
            // Find the rightmost position among all descendants of the parent
            // This ensures the branch line won't intersect with downstream branches
            const rightmostDescendantX = parent ? getRightmostDescendantX(parent.id, sortedNodes) : parentPos.x;
            
            // Position this branch to the right of all descendants to avoid crossing lines
            const minBranchX = Math.max(
              parentPos.x + (siblingIndex * horizontalSpacing),
              rightmostDescendantX + horizontalSpacing
            );
            
            desiredPos = {
              x: minBranchX,
              y: parentPos.y + verticalSpacing,
            };
            
            // When branching, shift ALL ancestor siblings to the right for clarity
            // This includes parent siblings, grandparent siblings, etc.
            shiftAllAncestorSiblings(node.id, sortedNodes);
            
            // Aggressively check for ANY overlaps and shift until completely clear
            // Keep checking until no overlaps exist at this position
            let hasOverlap = true;
            let maxIterations = 50; // Prevent infinite loops
            let iterations = 0;
            
            while (hasOverlap && iterations < maxIterations) {
              hasOverlap = false;
              iterations++;
              
              // Check against ALL existing locked positions
              for (const [existingNodeId, existingPos] of lockedPositions.entries()) {
                if (existingNodeId !== node.id && wouldOverlap(desiredPos, existingPos)) {
                  // Found an overlap - shift the existing node and its entire branch to the right
                  shiftBranchRight(existingNodeId, horizontalSpacing, sortedNodes);
                  hasOverlap = true;
                  // Don't break - continue checking in case we need to shift multiple branches
                }
              }
            }
          }
          
          lockedPositions.set(node.id, desiredPos);
        }
      }
    }
  });

  // Map to React Flow nodes with locked positions
  const nodes: Node[] = sortedNodes.map((node) => {
    const position = lockedPositions.get(node.id) || { x: 0, y: 0 };
    const isActive = node.id === treeData.activeNodeId;
    const isInActivePath = isNodeInActivePath(node.id, treeData);

    return {
      id: node.id,
      type: 'conversationNode',
      position: {
        x: position.x - nodeWidth / 2,
        y: position.y,
      },
      data: {
        ...node,
        isActive,
        isInActivePath,
      },
      style: {
        width: nodeWidth,
      },
    };
  });

  return { nodes, edges };
}

function isNodeInActivePath(nodeId: string, treeData: TreeData): boolean {
  if (!treeData.activeNodeId) return false;
  
  let currentId: string | null = treeData.activeNodeId;
  const nodeMap = new Map(treeData.nodes.map(n => [n.id, n]));
  
  while (currentId) {
    if (currentId === nodeId) return true;
    const node = nodeMap.get(currentId);
    currentId = node?.parentId || null;
  }
  
  return false;
}

// ============================================================================
// CUSTOM NODE COMPONENT
// ============================================================================

function ConversationNodeComponent({ data }: NodeProps) {
  const { prompt, isActive, isInActivePath, timestamp, branchLabel, isDarkMode } = data;

  // Node colors based on theme
  const nodeColors = isDarkMode ? {
    nodeBg: '#2f2f2f',
    promptBg: isActive ? '#3d3d3d' : '#353535',
    border: isActive ? '#3b82f6' : isInActivePath ? '#60a5fa' : '#4a4a4a',
    borderColor: '#4a4a4a',
    textColor: '#ececec',
  } : {
    nodeBg: '#ffffff',
    promptBg: isActive ? '#eff6ff' : '#f8fafc',
    border: isActive ? '#3b82f6' : isInActivePath ? '#60a5fa' : '#cbd5e1',
    borderColor: '#e2e8f0',
    textColor: '#1e293b',
  };

  return (
    <div
      style={{
        borderRadius: '12px',
        border: `2px solid ${nodeColors.border}`,
        backgroundColor: nodeColors.nodeBg,
        boxShadow: isActive ? '0 4px 16px rgba(59, 130, 246, 0.3)' : '0 2px 8px rgba(0,0,0,0.1)',
        overflow: 'hidden',
      }}
    >
      <Handle type="target" position={Position.Top} />
      
      {/* Prompt Section */}
      <div
        style={{
          padding: '16px',
          backgroundColor: nodeColors.promptBg,
          borderBottom: `1px solid ${nodeColors.borderColor}`,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
          <span
            style={{
              fontSize: '11px',
              fontWeight: 600,
              color: '#3b82f6',
              textTransform: 'uppercase',
              letterSpacing: '0.5px',
            }}
          >
            Prompt
          </span>
        </div>
        
          <div
            style={{
              fontSize: '14px',
              lineHeight: '1.5',
              color: nodeColors.textColor,
              maxHeight: '100px',
              overflow: 'hidden',
              display: '-webkit-box',
              WebkitLineClamp: 4,
              WebkitBoxOrient: 'vertical',
              textOverflow: 'ellipsis',
            }}
          >
            {prompt}
        </div>
        
        <div style={{ fontSize: '11px', color: isDarkMode ? '#8a8a8a' : '#94a3b8', marginTop: '12px' }}>
          {new Date(timestamp).toLocaleString(undefined, { 
            year: 'numeric', 
            month: 'numeric', 
            day: 'numeric', 
            hour: 'numeric', 
            minute: '2-digit' 
          })}
        </div>
      </div>
      
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

const nodeTypes = {
  conversationNode: ConversationNodeComponent,
};

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export function ConversationTreeChatbot() {
  const reactFlowInstance = useRef<ReactFlowInstance | null>(null);
  const [treeData, setTreeData] = useState<TreeData>({
    nodes: [],
    activeNodeId: null,
  });

  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [newPrompt, setNewPrompt] = useState('');
  const [leftWidth, setLeftWidth] = useState(40); // percentage
  const [isLeftMinimized, setIsLeftMinimized] = useState(false);
  const [isRightMinimized, setIsRightMinimized] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [isDarkMode, setIsDarkMode] = useState(false);

  // Initialize ReactFlow instance
  const onInit = useCallback((instance: ReactFlowInstance) => {
    reactFlowInstance.current = instance;
  }, []);

  // Handle divider dragging
  const handleMouseDown = useCallback(() => {
    setIsDragging(true);
  }, []);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (isDragging && !isLeftMinimized && !isRightMinimized) {
      const newWidth = (e.clientX / window.innerWidth) * 100;
      if (newWidth >= 0 && newWidth <= 100) {
        setLeftWidth(newWidth);
      }
    }
  }, [isDragging, isLeftMinimized, isRightMinimized]);

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  useEffect(() => {
    if (isDragging) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      return () => {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      };
    }
  }, [isDragging, handleMouseMove, handleMouseUp]);

  // Helper to focus on a specific node
  const focusNode = useCallback((nodeId: string) => {
    setTimeout(() => {
      if (reactFlowInstance.current) {
        const node = reactFlowInstance.current.getNode(nodeId);
        if (node) {
          reactFlowInstance.current.setCenter(
            node.position.x + nodeWidth / 2,
            node.position.y + nodeHeight / 2,
            { zoom: 1, duration: 800 }
          );
        }
      }
    }, 100);
  }, []);

  // Layout nodes whenever tree data changes
  useEffect(() => {
    const { nodes: layoutedNodes, edges: layoutedEdges } = layoutNodes(treeData);
    // Add isDarkMode to node data
    const nodesWithTheme = layoutedNodes.map(node => ({
      ...node,
      data: {
        ...node.data,
        isDarkMode,
      },
    }));
    setNodes(nodesWithTheme);
    setEdges(layoutedEdges);
  }, [treeData, isDarkMode]);

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => setNodes((nds) => applyNodeChanges(changes, nds)),
    []
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => setEdges((eds) => applyEdgeChanges(changes, eds)),
    []
  );

  const onNodeClick = useCallback((_event: React.MouseEvent, node: Node) => {
    setTreeData((prev) => ({
      ...prev,
      activeNodeId: node.id,
    }));
    // Auto-scroll to the clicked node
    focusNode(node.id);
  }, [focusNode]);

  // Send a new prompt - creates a connected node
  const handleSendPrompt = useCallback(() => {
    if (!newPrompt.trim()) return;

    const newNodeId = `${Date.now()}`;

    setTreeData((prev) => ({
      ...prev,
      nodes: [
        ...prev.nodes,
        {
          id: newNodeId,
          parentId: prev.activeNodeId,
          prompt: newPrompt,
          response: 'Response',
          timestamp: new Date(),
        },
      ],
      activeNodeId: newNodeId,
    }));

    setNewPrompt('');
    
    // Auto-scroll to the new node
    focusNode(newNodeId);
  }, [newPrompt, treeData.activeNodeId, focusNode]);

  const actualLeftWidth = isLeftMinimized ? 0 : isRightMinimized ? 100 : leftWidth;
  const actualRightWidth = isRightMinimized ? 0 : isLeftMinimized ? 100 : (100 - leftWidth);

  // Theme colors
  const theme = isDarkMode ? {
    chatBg: '#212121',
    graphBg: '#1a1a1a',
    containerBg: '#1a1a1a',
    messageBg: '#2f2f2f',
    messageText: '#ececec',
    inputBg: '#2f2f2f',
    inputText: '#ececec',
    inputBorder: '#3d3d3d',
    divider: '#3d3d3d',
    dividerHandle: '#6b6b6b',
    secondaryText: '#9a9a9a',
    buttonBg: '#ffffff',
    buttonText: '#64748b',
    buttonBorder: '#cbd5e1',
  } : {
    chatBg: '#f8fafc',
    graphBg: '#ffffff',
    containerBg: '#ffffff',
    messageBg: '#ffffff',
    messageText: '#1e293b',
    inputBg: '#f8fafc',
    inputText: '#1e293b',
    inputBorder: '#cbd5e1',
    divider: '#e2e8f0',
    dividerHandle: '#94a3b8',
    secondaryText: '#64748b',
    buttonBg: '#ffffff',
    buttonText: '#64748b',
    buttonBorder: '#cbd5e1',
  };

  return (
    <div style={{ width: '100vw', height: '100vh', display: 'flex', flexDirection: 'row', position: 'relative', backgroundColor: theme.containerBg }}>
      {/* Theme Toggle Button */}
      {!isRightMinimized && (
        <button
          onClick={() => setIsDarkMode(!isDarkMode)}
          style={{
            position: 'absolute',
            top: '10px',
            right: '68px',
            padding: '10px 20px',
            fontSize: '15px',
            fontWeight: 600,
            border: `1px solid ${theme.buttonBorder}`,
            backgroundColor: theme.buttonBg,
            color: theme.buttonText,
            borderRadius: '8px',
            cursor: 'pointer',
            zIndex: 50,
            boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
          }}
          title={isDarkMode ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
        >
          {isDarkMode ? 'Light' : 'Dark'}
        </button>
      )}

      {/* Left Side: Chatbot */}
      <div
        style={{
          width: `${actualLeftWidth}%`,
          height: '100vh',
          display: isLeftMinimized ? 'none' : 'flex',
          flexDirection: 'column',
          backgroundColor: theme.chatBg,
          position: 'relative',
        }}
      >
        {/* Minimize Button */}
        <button
          onClick={() => setIsLeftMinimized(true)}
          style={{
            position: 'absolute',
            top: '10px',
            right: '10px',
            width: '28px',
            height: '28px',
            padding: '0',
            fontSize: '16px',
            fontWeight: 600,
            border: '1px solid #cbd5e1',
            backgroundColor: '#ffffff',
            color: '#64748b',
            borderRadius: '6px',
            cursor: 'pointer',
            zIndex: 10,
            boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          −
        </button>

        {/* Chat Messages Area */}
        <div
          style={{
            flex: 1,
            padding: '20px',
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: '16px',
            backgroundColor: theme.chatBg,
          }}
        >
          {/* Render conversation messages from active path */}
          {treeData.nodes
            .filter(node => isNodeInActivePath(node.id, treeData) || node.id === treeData.activeNodeId)
            .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
            .map(node => (
              <div key={node.id}>
                {/* User Prompt */}
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '8px' }}>
                  <div
                    style={{
                      maxWidth: '80%',
                      padding: '12px 16px',
                      backgroundColor: '#3b82f6',
                      color: '#ffffff',
                      borderRadius: '12px 12px 4px 12px',
                      fontSize: '14px',
                      lineHeight: '1.5',
                    }}
                  >
                    {node.prompt}
                  </div>
                </div>
                {/* Bot Response */}
                <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
                  <div
                    style={{
                      maxWidth: '80%',
                      padding: '12px 16px',
                      backgroundColor: theme.messageBg,
                      color: theme.messageText,
                      borderRadius: '12px 12px 12px 4px',
                      fontSize: '14px',
                      lineHeight: '1.5',
                      border: `1px solid ${theme.inputBorder}`,
                    }}
                  >
                    {node.response}
                  </div>
                </div>
              </div>
            ))}
        </div>

        {/* Chat Input */}
        <div
          style={{
            padding: '20px',
            borderTop: `1px solid ${theme.divider}`,
            backgroundColor: theme.chatBg,
          }}
        >
          <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
            <input
              type="text"
              value={newPrompt}
              onChange={(e) => setNewPrompt(e.target.value)}
              onKeyPress={(e) => e.key === 'Enter' && handleSendPrompt()}
              placeholder={treeData.nodes.length === 0 ? "Start a new conversation..." : "Type your message..."}
              style={{
                flex: 1,
                padding: '14px 16px',
                fontSize: '14px',
                border: `1px solid ${theme.inputBorder}`,
                borderRadius: '10px',
                outline: 'none',
                backgroundColor: theme.inputBg,
                color: theme.inputText,
              }}
            />
            <button
              onClick={handleSendPrompt}
              disabled={!newPrompt.trim()}
              style={{
                padding: '14px 20px',
                fontSize: '14px',
                fontWeight: 600,
                border: 'none',
                borderRadius: '10px',
                backgroundColor: newPrompt.trim() ? '#3b82f6' : '#cbd5e1',
                color: '#ffffff',
                cursor: newPrompt.trim() ? 'pointer' : 'not-allowed',
              }}
            >
              {treeData.nodes.length === 0 ? 'Start' : 'Send'}
            </button>
          </div>
          <div style={{ marginTop: '12px', fontSize: '12px', color: theme.secondaryText, textAlign: 'center' }}>
            {treeData.nodes.length === 0 
              ? 'Start by typing a message above' 
              : treeData.activeNodeId 
                ? `Click a node in the tree to branch • ${treeData.nodes.length} nodes` 
                : 'Click a node in the tree to continue'}
          </div>
        </div>
      </div>

      {/* Resizable Divider */}
      {!isLeftMinimized && !isRightMinimized && (
        <div
          onMouseDown={handleMouseDown}
          style={{
            width: '8px',
            height: '100vh',
            backgroundColor: isDragging ? '#3b82f6' : theme.divider,
            cursor: 'col-resize',
            flexShrink: 0,
            transition: isDragging ? 'none' : 'background-color 0.2s',
            position: 'relative',
            zIndex: 20,
          }}
        >
          <div
            style={{
              position: 'absolute',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              width: '4px',
              height: '40px',
              backgroundColor: isDragging ? '#ffffff' : theme.dividerHandle,
              borderRadius: '2px',
              pointerEvents: 'none',
            }}
          />
        </div>
      )}

      {/* Show Chat Button (when left is minimized) */}
      {isLeftMinimized && (
        <button
          onClick={() => setIsLeftMinimized(false)}
          style={{
            position: 'absolute',
            top: '10px',
            left: '10px',
            width: '28px',
            height: '28px',
            padding: '0',
            fontSize: '16px',
            fontWeight: 600,
            border: '1px solid #3b82f6',
            backgroundColor: '#ffffff',
            color: '#3b82f6',
            borderRadius: '6px',
            cursor: 'pointer',
            zIndex: 30,
            boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          +
        </button>
      )}

      {/* Right Side: Graph */}
      <div
        style={{
          width: `${actualRightWidth}%`,
          height: '100vh',
          display: isRightMinimized ? 'none' : 'flex',
          flexDirection: 'column',
          backgroundColor: theme.graphBg,
          position: 'relative',
        }}
      >
        {/* Minimize Button */}
        <button
          onClick={() => setIsRightMinimized(true)}
          style={{
            position: 'absolute',
            top: '10px',
            right: '10px',
            width: '28px',
            height: '28px',
            padding: '0',
            fontSize: '16px',
            fontWeight: 600,
            border: '1px solid #cbd5e1',
            backgroundColor: '#ffffff',
            color: '#64748b',
            borderRadius: '6px',
            cursor: 'pointer',
            zIndex: 10,
            boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          −
        </button>

      {/* React Flow Canvas */}
      <div 
        style={{ 
          flex: 1, 
          position: 'relative',
          overflow: 'auto',
        }}
        className="react-flow-container"
      >
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={onNodeClick}
          onInit={onInit}
          nodeTypes={nodeTypes}
          fitView
          attributionPosition="bottom-right"
          defaultEdgeOptions={{
            type: 'smoothstep',
            markerEnd: { type: MarkerType.ArrowClosed },
          }}
          minZoom={0.2}
          maxZoom={1.5}
          panOnScroll={true}
          selectionOnDrag={false}
        >
          <Background color="#94a3b8" gap={16} />
          <Controls />
          <MiniMap
            nodeColor={(node) => {
              if (node.data.isActive) return '#3b82f6';
              if (node.data.isInActivePath) return '#60a5fa';
              return '#93c5fd';
            }}
            maskColor="rgba(0, 0, 0, 0.1)"
          />
        </ReactFlow>
      </div>
      </div>

      {/* Show Graph Button (when right is minimized) */}
      {isRightMinimized && (
        <button
          onClick={() => setIsRightMinimized(false)}
          style={{
            position: 'absolute',
            top: '10px',
            right: '10px',
            width: '28px',
            height: '28px',
            padding: '0',
            fontSize: '16px',
            fontWeight: 600,
            border: '1px solid #3b82f6',
            backgroundColor: '#ffffff',
            color: '#3b82f6',
            borderRadius: '6px',
            cursor: 'pointer',
            zIndex: 30,
            boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          +
        </button>
      )}
    </div>
  );
}

// ============================================================================
// USAGE EXAMPLE
// ============================================================================

/*
import { ConversationTreeChatbot } from './Context_Tree';

function App() {
  return <ConversationTreeChatbot />;
}
*/
